/**
 * Which server is the task authority: the one that holds the user's real task
 * list, runs automatic task writes (commitment rollover) and that clients use
 * for Tasks. With Task Sync on for one account on two servers, both rolling
 * the same commitment would each retire it and create a new membership, so
 * exactly one server may roll.
 *
 * The rule, in order:
 *  1. Task Sync decides when any server is signed in. Among the servers synced
 *     to this server's account, the one that hosts the user's Assistant wins
 *     (lower environment id if two do), else the lowest environment id. A
 *     server that is not signed in defers to a synced linked server: its own
 *     list is not the user's list, so it never becomes the authority just
 *     because the Assistant moved there.
 *  2. With no synced server anywhere, the server that hosts the Assistant
 *     (lower id if two), else every server is its own authority.
 *
 * What a linked machine hosts and whether it is synced is learned from
 * `describe` and kept in `reach-assistants.json`, so the answer is stable
 * across restarts and while that machine is offline, for up to three days.
 *
 * Rolling is gated twice more (`rolloverPermit`): the account-wide setting
 * (the latest choice on any synced server, so it follows authority), and a
 * handover check so the old and new authority never roll at once. See
 * docs/internals/assistant-cross-server-reach.md, "Task authority".
 *
 * The decision is held in this module (like the account week start in
 * contracts) so the environment descriptor, Task Sync status and rollover read
 * it without a layer cycle. Fork-owned.
 *
 * @module taskAuthority
 */
import type { ExecutionEnvironmentDescriptor, TaskAuthorityStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export interface TaskAuthorityMachine {
  readonly id: string;
  readonly label: string;
  /** Whether it hosts the user's live Assistant, as last described. */
  readonly hasAssistant: boolean;
  /**
   * Its Task Sync account key when synced, null when not synced, undefined
   * when unknown (an older build, or no answer within three days).
   */
  readonly account?: string | null | undefined;
}

export type TaskAuthorityDecision =
  | { readonly authority: true }
  | {
      readonly authority: false;
      readonly deferTo: { readonly id: string; readonly label: string };
      /**
       * `unsynced`: this server is not signed in to Task Sync and a linked one
       * is, so this server's task list is not the user's.
       */
      readonly reason?: "assistant" | "synced" | "unsynced";
    };

const byId = (a: { readonly id: string }, b: { readonly id: string }) => a.id.localeCompare(b.id);

export function decideTaskAuthority(input: {
  readonly selfId: string;
  readonly localAssistant: boolean;
  /** This server's Task Sync account key when synced, else null. */
  readonly selfAccount?: string | null;
  readonly linked: ReadonlyArray<TaskAuthorityMachine>;
}): TaskAuthorityDecision {
  const selfAccount = input.selfAccount ?? null;
  const others = input.linked.filter((machine) => machine.id !== input.selfId);
  const synced = others.filter(
    (machine) =>
      typeof machine.account === "string" &&
      (selfAccount === null || machine.account === selfAccount),
  );
  // An older build does not report Task Sync, but if it hosts the Assistant it
  // rolls by the old rule, so it must keep winning here or both would roll.
  const unknownHosts = others.filter(
    (machine) => machine.account === undefined && machine.hasAssistant,
  );

  if (selfAccount !== null || synced.length > 0) {
    const self = { id: input.selfId, label: "", hasAssistant: input.localAssistant };
    const candidates = [...(selfAccount === null ? [] : [self]), ...synced, ...unknownHosts];
    const hosts = candidates.filter((machine) => machine.hasAssistant).toSorted(byId);
    const winner = hosts[0] ?? candidates.toSorted(byId)[0]!;
    if (winner.id === input.selfId) return { authority: true };
    return {
      authority: false,
      deferTo: { id: winner.id, label: winner.label },
      reason: selfAccount === null ? "unsynced" : "synced",
    };
  }

  // Nobody is synced: the Assistant's server, as before Task Sync mattered.
  const hosts = others.filter((machine) => machine.hasAssistant).toSorted(byId);
  const first = hosts[0];
  if (first === undefined) return { authority: true };
  if (input.localAssistant && input.selfId.localeCompare(first.id) < 0) return { authority: true };
  return { authority: false, deferTo: { id: first.id, label: first.label }, reason: "assistant" };
}

/** What a linked machine said about its tasks in `describe`, and when. */
export interface TaskAnswer {
  readonly at: number;
  /** Its Task Sync account key when synced, else null. */
  readonly account: string | null;
  /** It was rolling commitments when it answered. */
  readonly rolls: boolean;
  readonly rollover: RolloverChoice;
}

/** A server's rollover setting and when it was last chosen (ISO, null: never). */
export interface RolloverChoice {
  readonly enabled: boolean;
  readonly setAt: string | null;
}

/** A linked machine's last answer about hosting the Assistant, and when it gave it. */
export interface AssistantAnswer {
  readonly hosts: boolean;
  readonly at: number;
  /** Its task state, from builds that report it. */
  readonly task?: TaskAnswer | undefined;
}

/**
 * How long a machine that stopped answering still counts as hosting the
 * Assistant, or as synced. Long enough to cover a sleeping or traveling
 * machine; short enough that a retired one does not keep every other server
 * from rolling commitments forever.
 */
export const ASSISTANT_ANSWER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How long a linked machine's "I roll commitments" still blocks this one. A
 * machine that has not answered for longer is asleep or gone, and a machine
 * that wakes refreshes before it rolls again (`AUTHORITY_FRESH_MS`).
 */
export const ROLL_CLAIM_TTL_MS = 15 * 60 * 1000;

/** A server whose last look at its linked machines is older than this asks again before rolling. */
export const AUTHORITY_FRESH_MS = 6 * 60 * 1000;

/** How long nobody rolling, with rollover on, counts as a gap worth a warning. */
export const ROLLOVER_GAP_WARN_MS = 20 * 60 * 1000;

/** Whether an answer still says the machine hosts the Assistant. */
export function hostsAssistant(answer: AssistantAnswer | undefined, nowMs: number): boolean {
  return answer !== undefined && answer.hosts && nowMs - answer.at < ASSISTANT_ANSWER_TTL_MS;
}

/** A machine's account as last described: undefined when unknown or older than three days. */
export function accountOf(
  answer: AssistantAnswer | undefined,
  nowMs: number,
): string | null | undefined {
  const task = answer?.task;
  if (task === undefined || nowMs - task.at >= ASSISTANT_ANSWER_TTL_MS) return undefined;
  return task.account;
}

/** Whether a machine said, recently enough to count, that it rolls commitments. */
export function claimsRollover(answer: AssistantAnswer | undefined, nowMs: number): boolean {
  const task = answer?.task;
  return task !== undefined && task.rolls && nowMs - task.at < ROLL_CLAIM_TTL_MS;
}

/**
 * The account-wide rollover setting: the latest deliberate choice on this
 * server or any linked server synced to the same account. A tie (none ever
 * stamped, as on builds before this) goes to on: off is the default, on is
 * always a choice someone made.
 */
export function effectiveRollover(
  local: RolloverChoice,
  peers: ReadonlyArray<RolloverChoice>,
): boolean {
  return winningRollover(local, peers).enabled;
}

/** The choice that wins: the latest stamp; any stamped choice beats an unstamped one. */
export function winningRollover(
  local: RolloverChoice,
  peers: ReadonlyArray<RolloverChoice>,
): RolloverChoice {
  let best = local;
  for (const peer of peers) {
    const a = peer.setAt ?? "";
    const b = best.setAt ?? "";
    if (a > b || (a === b && peer.enabled && !best.enabled)) best = peer;
  }
  return best;
}

/**
 * Stamp for keeping an unstamped choice (from builds before stamps): older
 * than any deliberate choice, so an explicit one made anywhere still wins.
 */
export const UNSTAMPED_ROLLOVER_AT = "1970-01-01T00:00:00.000Z";

export interface RolloverPermit {
  /** The account-wide setting. */
  readonly enabled: boolean;
  /** The choice it came from (this server's or a linked one's). */
  readonly choice: RolloverChoice;
  /** This server may roll now. */
  readonly rolls: boolean;
  /** This server's view of its linked machines is too old to trust: ask again first. */
  readonly stale: boolean;
  /** The linked machine still rolling, which this one waits for. */
  readonly waitingFor?: { readonly id: string; readonly label: string };
}

export interface LinkedTaskView {
  readonly id: string;
  readonly label: string;
  readonly answer: AssistantAnswer | undefined;
}

/**
 * Whether this server rolls now. It must be the authority, the setting must
 * be on account-wide, its view of linked machines fresh (so a machine waking
 * from sleep never rolls on what it knew before), and no linked machine may
 * still say it rolls: during a handover the new authority waits until the old
 * one has stepped down, so the two never roll at once. Rollover is a catch-up,
 * so waiting only delays a move by minutes, never skips one.
 */
export function rolloverPermit(input: {
  readonly decision: TaskAuthorityDecision;
  readonly selfAccount: string | null;
  readonly local: RolloverChoice;
  readonly linked: ReadonlyArray<LinkedTaskView>;
  readonly refreshedAt: number | null;
  readonly nowMs: number;
}): RolloverPermit {
  const sameAccount = input.linked.filter((machine) => {
    const account = accountOf(machine.answer, input.nowMs);
    return (
      typeof account === "string" && (input.selfAccount === null || account === input.selfAccount)
    );
  });
  const choice = winningRollover(
    input.local,
    sameAccount.flatMap((machine) =>
      machine.answer?.task === undefined ? [] : [machine.answer.task.rollover],
    ),
  );
  const enabled = choice.enabled;
  const stale =
    input.linked.length > 0 &&
    (input.refreshedAt === null || input.nowMs - input.refreshedAt > AUTHORITY_FRESH_MS);
  const holder = input.linked
    .filter((machine) => claimsRollover(machine.answer, input.nowMs))
    .toSorted(byId)[0];
  const rolls = enabled && input.decision.authority && !stale && holder === undefined;
  return {
    enabled,
    choice,
    rolls,
    stale,
    ...(holder !== undefined && input.decision.authority
      ? { waitingFor: { id: holder.id, label: holder.label } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// State in force on this server, kept current by TaskAuthorityLive.

let current: TaskAuthorityDecision = { authority: true };

interface LiveState {
  readonly selfAccount: string | null;
  readonly localAssistant: boolean;
  readonly local: RolloverChoice;
  readonly machines: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly refreshedAt: number | null;
}

let live: LiveState | null = null;
/** Since when rollover has been on with nobody rolling; null while someone rolls. */
let gapSince: number | null = null;
const deferralListeners = new Set<() => void>();

/** The decision in force on this server. */
export function currentTaskAuthority(): TaskAuthorityDecision {
  return current;
}

export function setTaskAuthority(decision: TaskAuthorityDecision): void {
  const wasDeferred = !current.authority;
  current = decision;
  if (wasDeferred !== !decision.authority) {
    for (const listener of deferralListeners) listener();
  }
}

const permitListeners = new Set<() => void>();

/** Called when this server may start rolling (it just became the one that rolls). */
export function onRolloverPermitGained(listener: () => void): () => void {
  permitListeners.add(listener);
  return () => permitListeners.delete(listener);
}

/** Set by the live layer when this server's own `rolls` turns on. */
export function notifyRolloverPermitGained(): void {
  for (const listener of permitListeners) listener();
}

/** Called when this server starts or stops deferring Tasks (the descriptor changes). */
export function onTaskDeferralChange(listener: () => void): () => void {
  deferralListeners.add(listener);
  return () => deferralListeners.delete(listener);
}

/** Set by the live layer after each recompute. */
export function setTaskAuthorityLiveState(state: LiveState | null): void {
  live = state;
}

/** The linked machines' last answers, with their labels. */
function linkedViews(): LinkedTaskView[] {
  return (live?.machines ?? []).map((machine) => ({
    ...machine,
    answer: knownHosts.get(machine.id),
  }));
}

/**
 * Whether this server rolls now, for `nowMs`, with `local` its own rollover
 * setting. Without the live layer (tests, one machine) it is the authority
 * and the local setting decides.
 */
export function taskRolloverPermit(local: RolloverChoice, nowMs: number): RolloverPermit {
  const permit: RolloverPermit =
    live === null
      ? {
          enabled: local.enabled,
          choice: local,
          rolls: local.enabled && current.authority,
          stale: false,
        }
      : rolloverPermit({
          decision: current,
          selfAccount: live.selfAccount,
          local,
          linked: linkedViews(),
          refreshedAt: live.refreshedAt,
          nowMs,
        });
  // While the Assistant moves away from here, this server stops rolling (and
  // says so in describe); the target starts once it commits and sees that.
  return moveHold ? { ...permit, rolls: false } : permit;
}

let moveHold = false;

/** Held while this server moves the Assistant away; released on commit or rollback. */
export function setRolloverMoveHold(held: boolean): void {
  moveHold = held;
}

/**
 * Whether nobody has rolled for a while although the setting is on. Updated
 * on each recompute; returns the gap's start when it should warn.
 */
export function noteRolloverGap(nowMs: number): number | null {
  if (live === null) return null;
  const permit = taskRolloverPermit(live.local, nowMs);
  const someoneRolls =
    permit.rolls || linkedViews().some((machine) => claimsRollover(machine.answer, nowMs));
  if (!permit.enabled || someoneRolls) {
    gapSince = null;
    return null;
  }
  gapSince ??= nowMs;
  return nowMs - gapSince >= ROLLOVER_GAP_WARN_MS ? gapSince : null;
}

/** What `describe` says about this server's tasks. */
export function describeTaskState(nowMs: number):
  | {
      readonly account: string | null;
      readonly rolls: boolean;
      readonly rollover: RolloverChoice;
    }
  | undefined {
  if (live === null) return undefined;
  return {
    account: live.selfAccount,
    rolls: taskRolloverPermit(live.local, nowMs).rolls,
    rollover: live.local,
  };
}

/**
 * When this server is not signed in to Task Sync and a linked server is: the
 * server that holds the user's task list. Task tools refuse instead of
 * answering from this server's list, which is not the user's.
 */
export function taskListElsewhere(): { readonly id: string; readonly label: string } | null {
  return !current.authority && current.reason === "unsynced" ? current.deferTo : null;
}

/** Status for Settings > Task Sync; null before the live layer has run. */
export function taskAuthorityStatus(nowMs: number): TaskAuthorityStatus | null {
  if (live === null) return null;
  const permit = taskRolloverPermit(live.local, nowMs);
  const views = linkedViews();
  return {
    authority: current.authority,
    ...(current.authority ? {} : { deferTo: current.deferTo }),
    synced: live.selfAccount !== null,
    assistantHere: live.localAssistant,
    signInNeeded: live.localAssistant && taskListElsewhere() !== null,
    rolls: permit.rolls,
    rolloverEnabled: permit.enabled,
    rolloverGap: gapSince !== null && permit.enabled && nowMs - gapSince >= ROLLOVER_GAP_WARN_MS,
    machines: views.map((machine) => {
      const account = accountOf(machine.answer, nowMs);
      return {
        id: machine.id,
        label: machine.label,
        synced: account === undefined ? null : account !== null,
        hasAssistant: hostsAssistant(machine.answer, nowMs),
        rolls: claimsRollover(machine.answer, nowMs),
        answeredAt: machine.answer?.task?.at ?? machine.answer?.at ?? null,
      };
    }),
  };
}

/**
 * The descriptor clients see: a server that defers still offers Tasks (a
 * client connected only to it keeps its list, which Task Sync shares), but
 * says so, and clients connected to the authority too use the authority's.
 */
export function withTaskAuthority(
  descriptor: ExecutionEnvironmentDescriptor,
): ExecutionEnvironmentDescriptor {
  if (current.authority) return descriptor;
  return { ...descriptor, capabilities: { ...descriptor.capabilities, tasksDeferred: true } };
}

/** What each linked machine last said about hosting the Assistant, by machine id. */
const knownHosts = new Map<string, AssistantAnswer>();

/**
 * Whether a linked machine hosts the Assistant, by its last answer however
 * old; undefined when it never answered. The 3-day expiry is only for task
 * authority: guarding against a second Assistant and offering to take it
 * back must remember a host that has been off for a week.
 */
export function lastAssistantHost(machineId: string): boolean | undefined {
  return knownHosts.get(machineId)?.hosts;
}

export function knownAssistantHosts(): ReadonlyMap<string, AssistantAnswer> {
  return knownHosts;
}

/** Records an answer. One without task state keeps the task state last heard. */
export function noteAssistantHost(machineId: string, answer: AssistantAnswer): void {
  const task = answer.task ?? knownHosts.get(machineId)?.task;
  knownHosts.set(machineId, task === undefined ? answer : { ...answer, task });
}

/** Whether this machine is the Assistant's home right now, or why that is not confirmed. */
export type HomeCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

let homeCheck: Effect.Effect<HomeCheck> = Effect.succeed({ ok: true });

/** Set by the live AssistantHome layer. */
export function registerAssistantHomeCheck(check: Effect.Effect<HomeCheck>): void {
  homeCheck = check;
}

/**
 * Asked before any Assistant schedule runs. A machine that was asleep or off
 * may have had the Assistant taken back meanwhile: it runs nothing until its
 * linked machines confirm none of them runs the Assistant.
 */
export const confirmAssistantHome: Effect.Effect<HomeCheck> = Effect.suspend(() => homeCheck);

let refreshHook: Effect.Effect<void> = Effect.void;
let freshHook: Effect.Effect<void> = Effect.void;

/** Set by the live layer: asks every linked machine again and recomputes. */
export function registerTaskAuthorityRefresh(
  refresh: Effect.Effect<void>,
  ensureFresh: Effect.Effect<void> = Effect.void,
): void {
  refreshHook = refresh;
  freshHook = ensureFresh;
}

/** Re-asks linked machines and recomputes now, as after the Assistant moves or a sign-in. */
export const refreshTaskAuthority: Effect.Effect<void> = Effect.suspend(() => refreshHook);

/** Re-asks linked machines only when the last look is too old to roll on (after sleep). */
export const ensureFreshTaskAuthority: Effect.Effect<void> = Effect.suspend(() => freshHook);

/** At most one poke-driven refresh this often. */
const POKE_MIN_INTERVAL_MS = 20_000;
let lastPokeAt = 0;
let pokePlanned = false;

/** A linked machine says its tasks changed: refresh soon, in the background. */
export const pokeTaskAuthority: Effect.Effect<void> = Effect.gen(function* () {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const wait = Math.max(0, lastPokeAt + POKE_MIN_INTERVAL_MS - nowMs);
  // Inside the window a poke is not dropped: one look is already planned for
  // its end, and that look sees this change too.
  if (pokePlanned) return;
  pokePlanned = true;
  lastPokeAt = nowMs + wait;
  // The poking machine may have just started and not answer yet: look, and
  // again a little later.
  yield* Effect.forkDetach(
    Effect.sleep(`${wait} millis`).pipe(
      Effect.andThen(Effect.sync(() => (pokePlanned = false))),
      Effect.andThen(refreshTaskAuthority),
      Effect.andThen(Effect.sleep("15 seconds")),
      Effect.andThen(refreshTaskAuthority),
    ),
  );
});
