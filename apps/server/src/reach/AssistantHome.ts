// @effect-diagnostics nodeBuiltinImport:off - reads this machine's network interfaces and the Assistant's MEMORY.md path.
/**
 * Where the user's Assistant runs, and moving it between linked machines.
 *
 * The home is the server that holds the live global Assistant marker; there
 * is no separate setting to drift. A move is run by the current home:
 * 1. check the target (linked, online, links back, has no Assistant),
 * 2. archive the Assistant here first, so there are never two live ones,
 * 3. send everything that moves (settings, schedules, MEMORY.md, recent
 *    conversation, open asks) for the target to adopt,
 * 4. on failure unarchive here; on success drop the local asks and let task
 *    authority follow on both machines.
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module AssistantHome
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ASSISTANT_HOME_DIR,
  AssistantHomeError,
  AssistantSettings,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EventId,
  findGlobalAssistantProject,
  MessageId,
  ModelSelection,
  ProjectId,
  ProjectScheduleId,
  RuntimeMode,
  ThreadId,
  type AssistantHomeInput,
  type AssistantHomeMachine,
  type AssistantHomeStatus,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { AgentMachines } from "../agentMachines/AgentMachines.ts";
import { linkTokenSubject } from "../agentMachines/linkToken.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { buildPairingUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";
import { Reach, type ReachMachine } from "./Reach.ts";
import { ReachBridge, type ReachAskRecord } from "./ReachBridge.ts";
import {
  makeMoveJournal,
  type MoveJournalUnreadable,
  type MoveRecord,
  type ReclaimMove,
  type SourceMove,
  type TargetMove,
} from "./assistantMoves.ts";
import { fetchPeerDescriptor } from "../agentMachines/AgentMachineClient.ts";
import { forkParked } from "../serverActivation.ts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AdoptResult,
  DescribeResult,
  MoveStatusResult,
  LinkBackResult,
  YieldResult,
  type AssistantBundle,
  type OverviewResult,
} from "./reachProtocol.ts";
import {
  type HomeCheck,
  describeTaskState,
  lastAssistantHost,
  noteAssistantHost,
  refreshTaskAuthority,
  registerAssistantHomeCheck,
} from "./taskAuthority.ts";

/** True only when this module runs from source, never in a packaged (bundled) build. */
export const faultsAllowedFor = (moduleUrl: string) =>
  moduleUrl.endsWith("/reach/AssistantHome.ts");
const FAULTS_ALLOWED = faultsAllowedFor(import.meta.url);

/** Recent conversation that moves with the Assistant. */
export const MOVED_MESSAGE_LIMIT = 200;

export interface AssistantHomeShape {
  readonly status: Effect.Effect<AssistantHomeStatus, AssistantHomeError>;
  readonly manage: (
    input: AssistantHomeInput,
  ) => Effect.Effect<AssistantHomeStatus, AssistantHomeError>;
  /** Fails when the Assistant runs on a linked machine, so a client never makes a second one. */
  readonly guardEnsure: Effect.Effect<void, AssistantHomeError>;
  /** Has a linked machine link this one back. */
  readonly linkBack: (input: {
    readonly id: string;
    readonly baseUrl: string;
  }) => Effect.Effect<{ readonly id: string; readonly label: string }, AssistantHomeError>;
  /** Reach ops: the target side of a move, a move asked for by another machine, a link back. */
  readonly adopt: (
    bundle: AssistantBundle,
    from: MovePeer,
  ) => Effect.Effect<AdoptResult, AssistantHomeError>;
  /** Only the machine named in the move record may commit or abort it. */
  readonly commit: (
    moveId: string,
    from: MovePeer,
  ) => Effect.Effect<MoveStatus, AssistantHomeError>;
  readonly abort: (moveId: string, from: MovePeer) => Effect.Effect<MoveStatus, AssistantHomeError>;
  readonly moveStatus: (moveId: string) => Effect.Effect<MoveStatus, AssistantHomeError>;
  /**
   * Another machine took the Assistant back while this one was unreachable:
   * pause the copy here. Only that machine may ask.
   */
  readonly yieldTo: (
    from: MovePeer,
  ) => Effect.Effect<{ readonly paused: boolean }, AssistantHomeError>;
  readonly handoff: (toEnvironmentId: string) => Effect.Effect<void, AssistantHomeError>;
  /**
   * Redeems a link-back pairing URL from a machine that asked. `confirm` asks
   * that machine, over the link, whether it sent this request: before
   * redeeming when the link already exists, right after when it is new (and
   * the new link is removed again when the machine says no or cannot answer).
   */
  readonly redeemLinkBack: (
    pairingUrl: string,
    from: MovePeer,
    confirm: Effect.Effect<void, Error>,
  ) => Effect.Effect<{ readonly id: string; readonly label: string }, AssistantHomeError>;
  /** Finishes or undoes interrupted moves; runs at start and every minute. */
  readonly reconcile: Effect.Effect<void>;
  /** Before an Assistant schedule runs: no linked machine runs the Assistant, or could. */
  readonly confirmHome: Effect.Effect<HomeCheck>;
}

export interface MovePeer {
  readonly environmentId: string;
  readonly label: string;
}

type MoveStatus = typeof MoveStatusResult.Type;
type MovedAsk = Omit<ReachAskRecord, "replyTo">;

/** Building the copy on the target, which writes up to 200 messages and the memory file. */
export const ADOPT_TIMEOUT = Duration.seconds(60);
/** Commit, abort and status checks of a move. */
export const MOVE_STEP_TIMEOUT = Duration.seconds(15);
export const MOVE_RECONCILE_INTERVAL = Duration.minutes(1);
/**
 * Whether a linked machine that could not say "no" blocks the Assistant's
 * schedules. No answer (offline, timeout): unless it last said no, since it may
 * have taken the Assistant back meanwhile. An answer it could not give (an
 * older build without reach, a token that needs relinking): only if it last
 * said it runs the Assistant, so a machine not updated yet never stops briefs.
 */
export function blocksSchedules(
  kind: "offline" | "timeout" | "relink" | "refused",
  last: boolean | undefined,
): boolean {
  return kind === "offline" || kind === "timeout" ? last !== false : last === true;
}

/** A confirmed home is not asked again for this long. */
const HOME_CONFIRM_REUSE_MS = 60_000;

const unavailable = Effect.fail(
  new AssistantHomeError({ detail: "This server cannot move the Assistant." }),
);

/** A reference, so tests and builds without the live layer need not provide it. */
export const AssistantHome = Context.Reference<AssistantHomeShape>("t3/reach/AssistantHome", {
  defaultValue: () => ({
    status: unavailable,
    manage: () => unavailable,
    guardEnsure: Effect.void,
    linkBack: () => unavailable,
    adopt: () => unavailable,
    commit: () => unavailable,
    abort: () => unavailable,
    moveStatus: () => Effect.succeed({ phase: "unknown" as const }),
    handoff: () => unavailable,
    yieldTo: () => unavailable,
    confirmHome: Effect.succeed({ ok: true } as const),
    redeemLinkBack: () => unavailable,
    reconcile: Effect.void,
  }),
});

const fail = (detail: string) => new AssistantHomeError({ detail });
const encodeAssistantSettings = Schema.encodeEffect(AssistantSettings);
const decodeAssistantSettings = Schema.decodeUnknownEffect(AssistantSettings);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const decodeRuntimeMode = Schema.decodeUnknownEffect(RuntimeMode);

/** 100.64.0.0/10, the tailnet range: the address a linked Mac most likely reaches. */
function isTailnetAddress(address: string): boolean {
  const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** Addresses another machine can likely use for this one; none while it listens on loopback only. */
export function suggestedAddresses(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: ReturnType<typeof NodeOS.networkInterfaces>;
}): Array<string> {
  const url = (host: string) => `http://${host.includes(":") ? `[${host}]` : host}:${input.port}`;
  if (input.host !== undefined && !isWildcardHost(input.host)) {
    return isLoopbackHost(input.host) ? [] : [url(input.host)];
  }
  if (input.host === undefined) return [];
  const ipv4 = Object.values(input.interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address);
  return [...ipv4.filter(isTailnetAddress), ...ipv4.filter((a) => !isTailnetAddress(a))].map(url);
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const projects = yield* ProjectionProjectRepository;
  const settingsService = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const auth = yield* EnvironmentAuth;
  const agentMachines = yield* AgentMachines;
  const reach = yield* Reach;
  const bridge = yield* ReachBridge;
  const httpClient = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);
  const rawJournal = yield* makeMoveJournal(config.stateDir);
  const readable = <A>(effect: Effect.Effect<A, MoveJournalUnreadable>) =>
    effect.pipe(Effect.mapError((error) => fail(error.detail)));
  const journal = {
    list: readable(rawJournal.list),
    get: (moveId: string, role: MoveRecord["role"]) => readable(rawJournal.get(moveId, role)),
    getTarget: (moveId: string) => readable(rawJournal.getTarget(moveId)),
    put: (record: MoveRecord) => readable(rawJournal.put(record)),
  };
  /**
   * Test hook for the live two-server run: dies hard at a named point. Only
   * when running from source (`node src/bin.ts`, tests); a packaged build runs
   * the bundled `.mjs`, where it never fires.
   */
  const testFault = (point: string) =>
    FAULTS_ALLOWED && process.env.CPLANE_REACH_FAULT === point
      ? Effect.logError(`CPLANE_REACH_FAULT: killing the server at ${point}`).pipe(
          Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGKILL"))),
        )
      : Effect.void;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const memoryPath = NodePath.join(config.stateDir, ASSISTANT_HOME_DIR, "MEMORY.md");
  const dispatch = (command: Parameters<typeof engine.dispatch>[0], what: string) =>
    engine
      .dispatch(command)
      .pipe(Effect.mapError((error) => fail(`${what}: ${String(error.message ?? error)}`)));

  const localAssistant = Effect.gen(function* () {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError(() => fail("Could not read this machine's Projects.")));
    const project = findGlobalAssistantProject(snapshot.projects) as
      | (OrchestrationProjectShell & {
          assistant: NonNullable<OrchestrationProjectShell["assistant"]>;
        })
      | undefined;
    const thread =
      project === undefined
        ? undefined
        : snapshot.threads.find((entry) => entry.id === project.assistant.coordinatorThreadId);
    return { project, thread };
  });

  /** The newest global Assistant here that moved away (archived). */
  const archivedAssistant = Effect.gen(function* () {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError(() => fail("Could not read this machine's Projects.")));
    const project = snapshot.projects
      .filter((entry) => entry.assistant?.scope === "global" && entry.assistant.archivedAt != null)
      .toSorted((a, b) =>
        (b.assistant?.archivedAt ?? "").localeCompare(a.assistant?.archivedAt ?? ""),
      )[0];
    if (project?.assistant == null) return undefined;
    return { project, threadId: project.assistant.coordinatorThreadId };
  });

  const caller = { threadId: "", threadTitle: "Assistant" };

  /** One linked machine as Settings shows it. Asks it now; falls back to what is known. */
  const machineState = (machine: ReachMachine, selfId: string) =>
    Effect.gen(function* () {
      const described = yield* reach
        .call(machine, "describe", {}, caller, DescribeResult)
        .pipe(Effect.result);
      const overview = yield* reach.overview(machine, caller).pipe(
        Effect.map(({ result }) => result as OverviewResult | null),
        Effect.catch(({ lastKnown }) => Effect.succeed(lastKnown)),
      );
      const projectsSeen = (overview?.projects ?? []).map(({ projectId, title }) => ({
        projectId,
        title,
      }));
      if (described._tag === "Success") {
        const at = DateTime.toEpochMillis(yield* DateTime.now);
        const tasks = described.success.tasks;
        noteAssistantHost(machine.id, {
          hosts: described.success.assistant !== null,
          at,
          ...(tasks === undefined ? {} : { task: { at, ...tasks } }),
        });
        return {
          id: machine.id,
          label: machine.label,
          state: "online",
          hostsAssistant: described.success.assistant !== null,
          taskSynced: tasks === undefined ? null : tasks.account !== null,
          linksBack:
            described.success.linked === undefined
              ? null
              : described.success.linked.includes(selfId),
          projects: projectsSeen,
        } satisfies AssistantHomeMachine;
      }
      const error = described.failure;
      const health = yield* reach.healthOf(machine.id);
      return {
        id: machine.id,
        label: machine.label,
        state:
          error.kind === "relink"
            ? "needs-relink"
            : error.kind === "refused"
              ? "incompatible"
              : "offline",
        detail: error.detail,
        ...(health.lastSeenAt !== null ? { lastSeenAt: health.lastSeenAt } : {}),
        // Its last answer, however old: an Assistant host off for a week still runs it.
        hostsAssistant: lastAssistantHost(machine.id) ?? null,
        linksBack: null,
        projects: projectsSeen,
      } satisfies AssistantHomeMachine;
    });

  const status = Effect.gen(function* () {
    const selfId = yield* environment.getEnvironmentId;
    const { project } = yield* localAssistant;
    const machines = yield* Effect.forEach(
      yield* reach.machines,
      (machine) => machineState(machine, selfId),
      { concurrency: 4 },
    );
    const hosts = machines
      .filter((machine) => machine.hostsAssistant === true)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(({ id, label }) => ({ id, label }));
    const pending = yield* pendingMove;
    const elsewhere = project === undefined ? (hosts[0] ?? null) : null;
    const homeMachine = machines.find((machine) => machine.id === elsewhere?.id);
    const ownTasks = describeTaskState(DateTime.toEpochMillis(yield* DateTime.now));
    return {
      here: project !== undefined,
      ...(ownTasks === undefined ? {} : { taskSynced: ownTasks.account !== null }),
      canReclaim:
        pending === undefined && homeMachine !== undefined && homeMachine.state !== "online",
      ...(pending !== undefined
        ? { pendingMove: { label: pending.peerLabel, startedAt: pending.startedAt } }
        : {}),
      elsewhere,
      conflicts: project === undefined ? hosts.slice(1) : hosts,
      machines,
      addresses: suggestedAddresses({
        host: config.host,
        port: config.port,
        interfaces: NodeOS.networkInterfaces(),
      }),
    } satisfies AssistantHomeStatus;
  });

  const linkedMachine = (id: string) =>
    Effect.gen(function* () {
      const machine = (yield* reach.machines).find((entry) => entry.id === id);
      if (machine === undefined) return yield* fail("That machine is not linked.");
      return machine;
    });

  /** Collects everything that moves, and notes what cannot move as it was. */
  const bundleOf = (project: OrchestrationProjectShell, threadId: ThreadId, moveId: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => fail("Could not read settings.")),
      );
      const row = Option.getOrUndefined(
        yield* projects
          .getById({ projectId: project.id })
          .pipe(Effect.mapError(() => fail("Could not read the Assistant's schedules."))),
      );
      const marker = row?.assistant;
      const prompts = marker?.schedulePrompts ?? {};
      const notes: Array<string> = [];
      const schedules = (marker?.schedules ?? []).map((schedule) => {
        const own = schedule.target === "coordinator" || schedule.target === threadId;
        // The other machine has no such thread: aim it at the Assistant, paused, and say so.
        if (!own) {
          notes.push(
            `"${schedule.name}" ran in another thread here, so it now runs in the Assistant and is paused. Turn it on in Settings, Assistant, Schedules if you still want it.`,
          );
        }
        return {
          id: schedule.id,
          name: schedule.name,
          cron: schedule.cron,
          enabled: own ? schedule.enabled : false,
          prompt: Object.hasOwn(prompts, schedule.id) ? (prompts[schedule.id] ?? "") : "",
        };
      });
      const memory = yield* fileSystem
        .readFileString(memoryPath)
        .pipe(Effect.orElseSucceed(() => null));
      const detail = Option.getOrUndefined(
        yield* snapshots
          .getThreadDetailSnapshot(threadId, { turnLimit: MOVED_MESSAGE_LIMIT })
          .pipe(Effect.mapError(() => fail("Could not read the Assistant's conversation."))),
      );
      const messages = (detail?.thread.messages ?? [])
        .filter(
          (message): message is typeof message & { role: "user" | "assistant" } =>
            (message.role === "user" || message.role === "assistant") &&
            message.text.trim().length > 0,
        )
        .slice(-MOVED_MESSAGE_LIMIT)
        .map((message) => ({
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        }));
      const asks = (yield* bridge.open)
        .filter((record) => record.replyTo === threadId)
        .map(({ replyTo: _replyTo, ...rest }) => rest);
      const bundle = {
        moveId,
        settings: yield* encodeAssistantSettings(settings.assistant).pipe(
          Effect.mapError(() => fail("Could not read the Assistant's settings.")),
        ),
        schedules,
        memory,
        messages,
        asks,
        modelSelection: detail?.thread.modelSelection ?? settings.defaultModelSelection,
        runtimeMode: detail?.thread.runtimeMode ?? "full-access",
      } satisfies AssistantBundle;
      return { bundle, notes };
    });

  const setArchived = (projectId: string, coordinatorThreadId: string, archived: boolean) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.flatMap((uuid) =>
        dispatch(
          {
            type: "project.meta.update",
            commandId: CommandId.make(
              `assistant-home:${archived ? "archive" : "restore"}:${projectId}:${uuid}`,
            ),
            projectId: ProjectId.make(projectId),
            assistant: { coordinatorThreadId: ThreadId.make(coordinatorThreadId), archived },
          },
          archived ? "Could not pause the Assistant here" : "Could not restore the Assistant here",
        ),
      ),
    );

  /** A new global Assistant Project, archived from its first marker write: never live. */
  const createPausedAssistant = (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly modelSelection: typeof ModelSelection.Type;
    readonly runtimeMode: typeof RuntimeMode.Type;
  }) =>
    Effect.gen(function* () {
      const home = NodePath.dirname(memoryPath);
      yield* fileSystem.makeDirectory(home, { recursive: true }).pipe(Effect.ignore);
      const createdAt = yield* nowIso;
      const projectId = ProjectId.make(input.projectId);
      const threadId = ThreadId.make(input.threadId);
      const what = "Could not prepare the Assistant here";
      yield* dispatch(
        {
          type: "project.create",
          commandId: CommandId.make(`assistant-home:project:${input.projectId}`),
          projectId,
          title: "Assistant",
          workspaceRoot: home,
          createWorkspaceRootIfMissing: true,
          createdAt,
        },
        what,
      );
      yield* dispatch(
        {
          type: "thread.create",
          commandId: CommandId.make(`assistant-home:thread:${input.threadId}`),
          threadId,
          projectId,
          title: "Assistant",
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
        what,
      );
      yield* dispatch(
        {
          type: "project.meta.update",
          commandId: CommandId.make(`assistant-home:marker:${input.projectId}`),
          projectId,
          defaultModelSelection: input.modelSelection,
          assistant: { coordinatorThreadId: threadId, scope: "global", archived: true },
        },
        what,
      );
    });

  const note = (threadId: string, id: string, summary: string, detail: string) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* dispatch(
        {
          type: "thread.activity.append",
          commandId: CommandId.make(id),
          threadId: ThreadId.make(threadId),
          activity: {
            id: EventId.make(id),
            tone: "info",
            kind: "assistant.moved",
            summary,
            payload: { detail },
            turnId: null,
            createdAt,
          },
          createdAt,
        },
        "Could not record the move",
      );
    }).pipe(Effect.ignore);

  const selfCaller = (threadId: string) =>
    environment.getDescriptor.pipe(
      Effect.map((descriptor) => ({ threadId, threadTitle: descriptor.label })),
    );

  const sourceDone = (record: SourceMove) =>
    Effect.gen(function* () {
      yield* bridge.dropFor(record.threadId);
      noteAssistantHost(record.peerId, {
        hosts: true,
        at: DateTime.toEpochMillis(yield* DateTime.now),
      });
      yield* journal.put({ ...record, phase: "done" });
      yield* note(
        record.threadId,
        `assistant-home:moved:${record.moveId}`,
        `Assistant moved to ${record.peerLabel}`,
        `This copy is read-only. Your Assistant now runs on ${record.peerLabel}.`,
      );
      yield* refreshTaskAuthority;
    });

  /** The source resumes its own Assistant; the target still owes a cleanup when it cannot be told now. */
  const sourceRollBack = (record: SourceMove, machine: ReachMachine) =>
    Effect.gen(function* () {
      const told = yield* reach
        .call(
          machine,
          "assistant.abort",
          { moveId: record.moveId },
          yield* selfCaller(record.threadId),
          MoveStatusResult,
          { timeout: MOVE_STEP_TIMEOUT },
        )
        .pipe(Effect.result);
      // Its copy is paused until a commit only this server sends, so resuming here is safe either way.
      yield* setArchived(record.projectId, record.threadId, false);
      yield* journal.put({
        ...record,
        phase: told._tag === "Success" ? "rolled-back" : "abort-pending",
      });
    });

  /** Asks the target to put its copy live. Undecided (timeout, offline) leaves the move to reconcile. */
  const sourceCommit = (record: SourceMove, machine: ReachMachine) =>
    Effect.gen(function* () {
      yield* journal.put({ ...record, phase: "committing" });
      const committed = yield* reach
        .call(
          machine,
          "assistant.commit",
          { moveId: record.moveId },
          yield* selfCaller(record.threadId),
          MoveStatusResult,
          { timeout: MOVE_STEP_TIMEOUT },
        )
        .pipe(Effect.result);
      if (committed._tag === "Success" && committed.success.phase === "committed") {
        yield* sourceDone({ ...record, phase: "committing" });
        return "done" as const;
      }
      if (committed._tag === "Failure" && committed.failure.kind !== "refused") {
        return "pending" as const;
      }
      yield* sourceRollBack({ ...record, phase: "committing" }, machine);
      return "rolled-back" as const;
    });

  /** The current home moves the Assistant to a linked machine. */
  const moveFromHere = (machine: ReachMachine) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const selfId = yield* environment.getEnvironmentId;
        const { project, thread } = yield* localAssistant;
        if (project === undefined || thread === undefined) {
          return yield* fail("The Assistant does not run on this machine.");
        }
        const target = yield* machineState(machine, selfId);
        if (target.state !== "online") {
          return yield* fail(target.detail ?? `${machine.label} is not reachable.`);
        }
        if (target.hostsAssistant === true) {
          return yield* fail(`${machine.label} already runs an Assistant. Keep one of them first.`);
        }
        if (target.linksBack !== true) {
          return yield* fail(
            `${machine.label} has not linked this machine back, so an Assistant there could not reach the Projects here. Use "Let ${machine.label} reach this machine" first.`,
          );
        }
        const phase = thread.session?.status;
        if (phase === "running" || phase === "starting") {
          return yield* fail("The Assistant is working. Move it when its turn ends.");
        }
        const moveId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
        const { bundle, notes } = yield* bundleOf(project, thread.id, moveId);
        const record: SourceMove = {
          role: "source",
          moveId,
          peerId: machine.id,
          peerLabel: machine.label,
          phase: "adopting",
          projectId: project.id,
          threadId: thread.id,
          startedAt: yield* nowIso,
        };
        // Recorded, then paused here: until the target commits, no machine runs one.
        yield* journal.put(record);
        yield* setArchived(project.id, thread.id, true);
        const adopted = yield* reach
          .call(machine, "assistant.adopt", bundle, yield* selfCaller(thread.id), AdoptResult, {
            timeout: ADOPT_TIMEOUT,
          })
          .pipe(Effect.result);
        if (adopted._tag === "Failure") {
          yield* sourceRollBack(record, machine);
          return yield* fail(`Not moved: ${adopted.failure.detail} Your Assistant stays here.`);
        }
        const outcome = yield* sourceCommit(record, machine);
        if (outcome === "rolled-back") {
          return yield* fail(
            `Not moved: ${machine.label} did not take it. Your Assistant stays here.`,
          );
        }
        if (outcome === "pending") {
          return yield* fail(
            `${machine.label} has your Assistant ready but has not confirmed it is running. It finishes when ${machine.label} answers; until then the Assistant is paused.`,
          );
        }
        return notes;
      }),
    );

  /** The target side of a move: a paused copy, idempotent by move id. */
  const adopt: AssistantHomeShape["adopt"] = (bundle, from) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const known = yield* journal.getTarget(bundle.moveId);
        if (Option.isSome(known)) {
          if (known.value.phase === "aborted") return yield* fail("That move was cancelled.");
          if (known.value.phase !== "preparing") {
            return { projectId: known.value.projectId, threadId: known.value.threadId };
          }
          // A crash or failure left a half-built copy: remove it and build again.
          yield* undoTarget(known.value);
        }
        const existing = yield* localAssistant;
        if (existing.project !== undefined) {
          return yield* fail("This machine already runs an Assistant.");
        }
        const modelSelection = yield* decodeModelSelection(bundle.modelSelection).pipe(
          Effect.mapError(() => fail("The Assistant's model could not be read.")),
        );
        const runtimeMode = yield* decodeRuntimeMode(bundle.runtimeMode).pipe(
          Effect.orElseSucceed(() => "full-access" as const),
        );
        const settingsBefore = yield* settingsService.getSettings.pipe(
          Effect.mapError(() => fail("Could not read settings.")),
        );
        const previousSettings = yield* encodeAssistantSettings(settingsBefore.assistant).pipe(
          Effect.mapError(() => fail("Could not read settings.")),
        );
        const previousMemory = yield* fileSystem
          .readFileString(memoryPath)
          .pipe(Effect.orElseSucceed(() => null));
        // An Assistant that moved away from here before holds the home folder: reuse it.
        const archived = yield* archivedAssistant;
        const projectId =
          archived !== undefined
            ? (archived.project.id as string)
            : yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const threadId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const record: TargetMove = {
          role: "target",
          moveId: bundle.moveId,
          peerId: from.environmentId,
          peerLabel: from.label,
          phase: "preparing",
          projectId,
          threadId,
          created: archived === undefined,
          ...(archived !== undefined ? { previousThreadId: archived.threadId as string } : {}),
          previousSettings,
          previousMemory,
          asks: bundle.asks,
          startedAt: yield* nowIso,
        };
        // Journaled before anything exists, so an abort or a retry always finds what was made.
        yield* journal.put(record);
        const build = Effect.gen(function* () {
          // Made paused (archived) from the first command: never live beside the source's copy.
          if (archived === undefined) {
            yield* createPausedAssistant({ projectId, threadId, modelSelection, runtimeMode });
          } else {
            yield* dispatch(
              {
                type: "thread.create",
                commandId: CommandId.make(`assistant-home:thread:${threadId}`),
                threadId: ThreadId.make(threadId),
                projectId: archived.project.id,
                title: "Assistant",
                modelSelection,
                runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: yield* nowIso,
              },
              "Could not prepare the Assistant here",
            );
            yield* dispatch(
              {
                type: "project.meta.update",
                commandId: CommandId.make(`assistant-home:coordinator:${threadId}`),
                projectId: archived.project.id,
                assistant: { coordinatorThreadId: ThreadId.make(threadId), archived: true },
              },
              "Could not prepare the Assistant here",
            );
          }
          yield* testFault("crash-after-target-create");
        });
        const home = { projectId, threadId };
        const steps = Effect.gen(function* () {
          const settings = yield* decodeAssistantSettings(bundle.settings).pipe(
            Effect.mapError(() => fail("The Assistant's settings could not be read.")),
          );
          yield* settingsService
            .updateSettings({ assistant: settings })
            .pipe(Effect.mapError(() => fail("Could not save the Assistant's settings.")));
          // A reused Project still has its old schedules: echo each one's version, as any write must.
          const stored = Option.getOrUndefined(
            yield* projects
              .getById({ projectId: ProjectId.make(home.projectId) })
              .pipe(Effect.mapError(() => fail("Could not read the Assistant's schedules."))),
          )?.assistant?.schedules;
          const versionOf = new Map(
            (stored ?? []).map((entry) => [entry.id as string, entry.updatedAt]),
          );
          if (bundle.schedules.length > 0 || (stored ?? []).length > 0) {
            yield* dispatch(
              {
                type: "project.meta.update",
                commandId: CommandId.make(
                  `assistant-home:schedules:${bundle.moveId}:${home.threadId}`,
                ),
                projectId: ProjectId.make(home.projectId),
                assistant: {
                  coordinatorThreadId: ThreadId.make(home.threadId),
                  schedules: bundle.schedules.map((schedule) => {
                    const updatedAt = versionOf.get(schedule.id);
                    return {
                      id: ProjectScheduleId.make(schedule.id),
                      name: schedule.name,
                      cron: schedule.cron,
                      target: "coordinator" as const,
                      enabled: schedule.enabled,
                      prompt: schedule.prompt,
                      ...(updatedAt !== undefined ? { updatedAt } : {}),
                    };
                  }),
                },
              },
              "Could not recreate the Assistant's schedules",
            );
          }
          if (bundle.memory !== null) {
            yield* fileSystem
              .makeDirectory(NodePath.dirname(memoryPath), { recursive: true })
              .pipe(Effect.ignore);
            yield* fileSystem
              .writeFileString(memoryPath, bundle.memory)
              .pipe(Effect.mapError(() => fail("Could not write the Assistant's memory.")));
          }
          const moved = bundle.messages.map((message, index) => ({
            messageId: MessageId.make(`moved:${bundle.moveId}:${index}`),
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
          }));
          const [first, ...rest] = moved;
          if (first !== undefined) {
            yield* dispatch(
              {
                type: "thread.history.import",
                commandId: CommandId.make(
                  `assistant-home:history:${bundle.moveId}:${home.threadId}`,
                ),
                threadId: ThreadId.make(home.threadId),
                messages: [first, ...rest],
              },
              "Could not bring the conversation over",
            );
          }
        });
        yield* Effect.andThen(build, steps).pipe(Effect.tapError(() => abortTarget(record)));
        yield* journal.put({ ...record, phase: "adopted" });
        return { projectId: home.projectId, threadId: home.threadId } satisfies AdoptResult;
      }),
    );

  /**
   * Undoes a copy, whole or half-built: settings and memory back as they were
   * (a moved MEMORY.md removed when there was none), a made project deleted.
   * Each step tolerates the part never having been made.
   */
  const undoTarget = (record: TargetMove) =>
    Effect.gen(function* () {
      const previous = yield* decodeAssistantSettings(record.previousSettings).pipe(Effect.option);
      if (previous._tag === "Some") {
        yield* settingsService.updateSettings({ assistant: previous.value }).pipe(Effect.ignore);
      }
      if (record.previousMemory !== null) {
        yield* fileSystem.writeFileString(memoryPath, record.previousMemory).pipe(Effect.ignore);
      } else {
        yield* fileSystem.remove(memoryPath, { force: true }).pipe(Effect.ignore);
      }
      if (record.created) {
        // Removes the coordinator thread and the marker with it, and frees the home folder.
        yield* dispatch(
          {
            type: "project.delete",
            commandId: CommandId.make(`assistant-home:abort-project:${record.moveId}`),
            projectId: ProjectId.make(record.projectId),
            force: true,
          },
          "Could not remove the cancelled copy",
        ).pipe(
          Effect.tapError((error) => Effect.logWarning(error.detail)),
          Effect.ignore,
        );
      } else if (record.previousThreadId !== undefined) {
        // Back to how the archived Assistant was: its old coordinator, the fresh thread gone.
        yield* dispatch(
          {
            type: "project.meta.update",
            commandId: CommandId.make(`assistant-home:abort-coordinator:${record.moveId}`),
            projectId: ProjectId.make(record.projectId),
            assistant: {
              coordinatorThreadId: ThreadId.make(record.previousThreadId),
              archived: true,
            },
          },
          "Could not restore the archived Assistant",
        ).pipe(Effect.ignore);
        yield* dispatch(
          {
            type: "thread.delete",
            commandId: CommandId.make(`assistant-home:abort-thread:${record.moveId}`),
            threadId: ThreadId.make(record.threadId),
          },
          "Could not remove the cancelled copy",
        ).pipe(Effect.ignore);
      }
    });

  const abortTarget = (record: TargetMove) =>
    undoTarget(record).pipe(Effect.andThen(journal.put({ ...record, phase: "aborted" })));

  const fromMovePeer = (
    record: { readonly peerId: string; readonly peerLabel: string },
    from: MovePeer,
  ) =>
    record.peerId === from.environmentId
      ? Effect.void
      : Effect.fail(
          fail(`Only ${record.peerLabel}, which started this move, can finish or cancel it.`),
        );

  const abort: AssistantHomeShape["abort"] = (moveId, from) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const known = yield* journal.getTarget(moveId);
        if (Option.isNone(known)) {
          // Refuse a late adopt with this id.
          yield* journal.put({
            role: "target",
            moveId,
            peerId: from.environmentId,
            peerLabel: from.label,
            phase: "aborted",
            projectId: "",
            threadId: "",
            created: false,
            previousSettings: null,
            previousMemory: null,
            asks: [],
            startedAt: yield* nowIso,
          });
          return { phase: "aborted" as const };
        }
        yield* fromMovePeer(known.value, from);
        if (known.value.phase === "committed") {
          return yield* fail("That move already finished; move the Assistant back instead.");
        }
        if (known.value.phase === "adopted" || known.value.phase === "preparing") {
          yield* abortTarget(known.value);
        }
        return { phase: "aborted" as const };
      }),
    );

  const commit: AssistantHomeShape["commit"] = (moveId, from) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const known = yield* journal.getTarget(moveId);
        if (Option.isNone(known)) return yield* fail("There is no such move to finish here.");
        const record = known.value;
        yield* fromMovePeer(record, from);
        if (record.phase === "committed") return { phase: "committed" as const };
        if (record.phase !== "adopted") return yield* fail("There is no such move to finish here.");
        yield* setArchived(record.projectId, record.threadId, false);
        const asks = Array.isArray(record.asks) ? (record.asks as ReadonlyArray<MovedAsk>) : [];
        for (const ask of asks) yield* bridge.track({ ...ask, replyTo: record.threadId });
        noteAssistantHost(record.peerId, {
          hosts: false,
          at: DateTime.toEpochMillis(yield* DateTime.now),
        });
        yield* journal.put({ ...record, phase: "committed" });
        yield* note(
          record.threadId,
          `assistant-home:arrived:${moveId}`,
          `Assistant moved here from ${record.peerLabel}`,
          "Its settings, schedules, memory and recent conversation came with it.",
        );
        yield* Effect.forkDetach(refreshTaskAuthority);
        return { phase: "committed" as const };
      }),
    );

  const moveStatus: AssistantHomeShape["moveStatus"] = (moveId) =>
    journal.get(moveId, "target").pipe(
      Effect.map((known): MoveStatus => {
        if (Option.isNone(known) || known.value.role !== "target") return { phase: "unknown" };
        // A half-built copy is not ready: the source treats it as not adopted and rolls back.
        return known.value.phase === "preparing"
          ? { phase: "unknown" }
          : { phase: known.value.phase };
      }),
    );

  /**
   * Finishes or undoes moves a timeout, crash or sleep interrupted. A source
   * in `adopting` never heard back: it cancels and resumes its own copy. In
   * `committing` it asks the target: committed means done, a paused copy
   * gets the commit again, anything else rolls back. `abort-pending` keeps
   * telling the target until it hears it.
   */
  const reconcile = lock
    .withPermits(1)(
      Effect.gen(function* () {
        for (const record of yield* journal.list) {
          // Under the lock no adopt is running: a `preparing` copy is what a crash left behind.
          if (record.role === "target") {
            if (record.phase === "preparing") yield* abortTarget(record);
            continue;
          }
          if (record.role === "reclaim") {
            if (record.phase === "yield-pending") yield* tellYield(record);
            continue;
          }
          if (record.phase === "done" || record.phase === "rolled-back") continue;
          const machine = (yield* reach.machines).find((entry) => entry.id === record.peerId) ?? {
            id: record.peerId,
            label: record.peerLabel,
          };
          if (record.phase === "adopting") {
            yield* sourceRollBack(record, machine);
            continue;
          }
          if (record.phase === "abort-pending") {
            const told = yield* reach
              .call(
                machine,
                "assistant.abort",
                { moveId: record.moveId },
                yield* selfCaller(record.threadId),
                MoveStatusResult,
                { timeout: MOVE_STEP_TIMEOUT },
              )
              .pipe(Effect.result);
            if (told._tag === "Success") yield* journal.put({ ...record, phase: "rolled-back" });
            continue;
          }
          const seen = yield* reach
            .call(
              machine,
              "assistant.moveStatus",
              { moveId: record.moveId },
              yield* selfCaller(record.threadId),
              MoveStatusResult,
              { timeout: MOVE_STEP_TIMEOUT },
            )
            .pipe(Effect.result);
          if (seen._tag === "Failure") continue;
          if (seen.success.phase === "committed") yield* sourceDone(record);
          else if (seen.success.phase === "adopted") yield* sourceCommit(record, machine);
          else yield* sourceRollBack(record, machine);
        }
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("assistant move reconcile failed", { cause: String(cause) }),
      ),
    );

  /** A move this server started and has not finished, for Settings. */
  const pendingMove = journal.list.pipe(
    Effect.map((moves) =>
      moves.find(
        (move): move is SourceMove =>
          move.role === "source" && (move.phase === "adopting" || move.phase === "committing"),
      ),
    ),
  );

  const manage: AssistantHomeShape["manage"] = (input) =>
    Effect.gen(function* () {
      if (input.action === "status") return yield* status;
      if (input.action === "reclaim") {
        yield* reclaim;
        yield* refreshTaskAuthority;
        return yield* status;
      }
      const { project } = yield* localAssistant;
      if (input.to === "local") {
        if (project !== undefined) return yield* status;
        const current = yield* status;
        if (current.elsewhere === null) {
          return yield* fail("No linked machine runs your Assistant. Open it to create it here.");
        }
        const home = yield* linkedMachine(current.elsewhere.id);
        const selfId = yield* environment.getEnvironmentId;
        // The current home runs the move.
        yield* reach
          .call(home, "assistant.handoff", { to: selfId }, caller, Schema.Unknown)
          .pipe(Effect.mapError((error) => fail(error.detail)));
        yield* refreshTaskAuthority;
        return yield* status;
      }
      if (project === undefined) {
        return yield* fail(
          "Move the Assistant from the machine that runs it, or choose This machine there.",
        );
      }
      const notes = yield* moveFromHere(yield* linkedMachine(input.to));
      return { ...(yield* status), ...(notes.length > 0 ? { notes } : {}) };
    });

  /** Linked machines this one took the Assistant back from, still owed a yield. */
  const yieldOwed = journal.list.pipe(
    Effect.map(
      (moves) =>
        new Set(
          moves
            .filter((move) => move.role === "reclaim" && move.phase === "yield-pending")
            .map((move) => move.peerId),
        ),
    ),
  );

  const askHosts = (machine: ReachMachine) =>
    reach
      .call(machine, "describe", {}, caller, DescribeResult, {
        timeout: MOVE_STEP_TIMEOUT,
        fresh: true,
      })
      .pipe(
        Effect.tap((described) =>
          DateTime.now.pipe(
            Effect.map((now) =>
              noteAssistantHost(machine.id, {
                hosts: described.assistant !== null,
                at: DateTime.toEpochMillis(now),
              }),
            ),
          ),
        ),
        Effect.map((described) => described.assistant !== null),
      );

  /**
   * Before a client creates the Assistant here: refuses while a linked machine
   * runs it, and brings back the copy that moved away from here (archived)
   * instead of making a second, once every linked machine says it runs none.
   */
  const guardEnsure = lock.withPermits(1)(
    Effect.gen(function* () {
      const { project } = yield* localAssistant;
      if (project !== undefined) return;
      if ((yield* pendingMove) !== undefined) {
        return yield* fail("Your Assistant is moving. It is back when the move finishes.");
      }
      const owed = yield* yieldOwed;
      const archived = yield* archivedAssistant;
      for (const machine of yield* reach.machines) {
        if (owed.has(machine.id)) continue;
        const last = lastAssistantHost(machine.id);
        // Nothing says it runs one, and there is no copy here to bring back: a first Assistant.
        if (last === false || (last === undefined && archived === undefined)) continue;
        const asked = yield* askHosts(machine).pipe(Effect.result);
        if (asked._tag === "Success" && !asked.success) continue;
        if (asked._tag === "Success") {
          return yield* fail(
            `Your Assistant runs on ${machine.label}. Open it there, or move it here in Settings, Assistant.`,
          );
        }
        return yield* fail(
          last === true
            ? `Your Assistant runs on ${machine.label}, which cannot be reached. Open it there when it is back, or take it back in Settings, Assistant.`
            : `Could not check whether ${machine.label} runs your Assistant: ${asked.failure.detail} If it is gone for good, take the Assistant back in Settings, Assistant.`,
        );
      }
      if (archived === undefined) return;
      yield* setArchived(archived.project.id, archived.threadId, false);
    }),
  );

  /**
   * Whether this machine may run the Assistant's schedules now: every linked
   * machine is asked. One that answers it runs the Assistant, or cannot be
   * reached while its last answer was not a clear no, means skip. A yes is
   * reused for a minute, so a burst of due runs asks once.
   */
  let confirmedAt = Number.NEGATIVE_INFINITY;
  const confirmHome: Effect.Effect<HomeCheck> = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs - confirmedAt < HOME_CONFIRM_REUSE_MS) return { ok: true } as const;
    const answers = yield* Effect.forEach(
      yield* reach.machines,
      (machine) =>
        askHosts(machine).pipe(
          Effect.result,
          Effect.map((asked) => ({ machine, asked })),
        ),
      { concurrency: 4 },
    );
    for (const { machine, asked } of answers) {
      if (asked._tag === "Success" && asked.success) {
        return { ok: false, detail: `${machine.label} runs your Assistant.` } as const;
      }
      if (
        asked._tag === "Failure" &&
        blocksSchedules(asked.failure.kind, lastAssistantHost(machine.id))
      ) {
        return {
          ok: false,
          detail: `Could not confirm with ${machine.label} that it does not run your Assistant: ${asked.failure.detail}`,
        } as const;
      }
    }
    confirmedAt = nowMs;
    return { ok: true } as const;
  });

  /** Tells the machine the Assistant was taken back from to pause its copy. */
  const tellYield = (record: ReclaimMove) =>
    Effect.gen(function* () {
      const machine = (yield* reach.machines).find((entry) => entry.id === record.peerId);
      if (machine === undefined) {
        // Unlinked since: nothing to tell.
        yield* journal.put({ ...record, phase: "done" });
        return;
      }
      const { thread } = yield* localAssistant;
      const told = yield* reach
        .call(machine, "assistant.yield", {}, yield* selfCaller(thread?.id ?? ""), YieldResult, {
          timeout: MOVE_STEP_TIMEOUT,
        })
        .pipe(Effect.result);
      if (told._tag === "Success") {
        noteAssistantHost(record.peerId, {
          hosts: false,
          at: DateTime.toEpochMillis(yield* DateTime.now),
        });
        yield* journal.put({ ...record, phase: "done" });
      }
    });

  /**
   * The user takes the Assistant back to this machine while the machine that
   * runs it is unreachable. The copy here (or a new one) goes live now; the
   * other machine is told to pause its copy whenever it answers.
   */
  const reclaim = lock.withPermits(1)(
    Effect.gen(function* () {
      const { project } = yield* localAssistant;
      if (project !== undefined) return;
      if ((yield* pendingMove) !== undefined) {
        return yield* fail("Your Assistant is moving. Wait for the move to finish.");
      }
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const hosts = (yield* reach.machines).filter(
        (machine) => lastAssistantHost(machine.id) === true,
      );
      for (const machine of hosts) {
        const answer = yield* askHosts(machine).pipe(Effect.result);
        if (answer._tag === "Success" && answer.success) {
          return yield* fail(
            `${machine.label} is online and runs your Assistant. Move it here instead.`,
          );
        }
      }
      const startedAt = yield* nowIso;
      for (const machine of hosts) {
        const moveId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
        yield* journal.put({
          role: "reclaim",
          moveId,
          peerId: machine.id,
          peerLabel: machine.label,
          phase: "yield-pending",
          startedAt,
        });
        noteAssistantHost(machine.id, { hosts: false, at: now });
      }
      const archived = yield* archivedAssistant;
      if (archived !== undefined) {
        yield* setArchived(archived.project.id, archived.threadId, false);
        yield* note(
          archived.threadId as string,
          `assistant-home:reclaimed:${startedAt}`,
          "Assistant taken back to this machine",
          hosts.length === 0
            ? "It runs here again."
            : `It runs here again. ${hosts.map((machine) => machine.label).join(", ")} pauses its copy when it is back online.`,
        );
      }
      for (const record of (yield* journal.list).filter(
        (move): move is ReclaimMove => move.role === "reclaim" && move.phase === "yield-pending",
      )) {
        yield* tellYield(record);
      }
    }),
  );

  const yieldTo: AssistantHomeShape["yieldTo"] = (from) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const machine = yield* linkedMachine(from.environmentId);
        // Only to a machine that runs one now, so a stray request cannot leave none.
        const hosts = yield* askHosts(machine).pipe(Effect.mapError((error) => fail(error.detail)));
        if (!hosts) {
          return yield* fail(`${machine.label} does not run an Assistant, so the one here stays.`);
        }
        const { project, thread } = yield* localAssistant;
        if (project === undefined) return { paused: false };
        yield* setArchived(project.id, project.assistant.coordinatorThreadId, true);
        const phase = thread?.session?.status;
        if (thread !== undefined && (phase === "running" || phase === "starting")) {
          // Pausing stops new work; a turn already running stops here too.
          const at = yield* nowIso;
          yield* dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`assistant-home:yield-interrupt:${thread.id}:${at}`),
              threadId: thread.id,
              createdAt: at,
            },
            "Could not stop the Assistant's turn",
          ).pipe(Effect.ignore);
        }
        if (thread !== undefined) yield* bridge.dropFor(thread.id);
        yield* note(
          project.assistant.coordinatorThreadId,
          `assistant-home:yielded:${yield* nowIso}`,
          `Assistant taken back by ${machine.label}`,
          `This copy is read-only. Your Assistant runs on ${machine.label}, which took it back while this machine was unreachable.`,
        );
        yield* Effect.forkDetach(refreshTaskAuthority);
        return { paused: true };
      }),
    );

  const linkBack: AssistantHomeShape["linkBack"] = ({ id, baseUrl }) =>
    Effect.gen(function* () {
      const machine = yield* linkedMachine(id);
      const label = (yield* environment.getDescriptor).label;
      const issued = yield* auth
        .createPairingLink({
          ttl: Duration.minutes(10),
          label: `Link back from ${machine.label}`,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          // A machine link for that machine: renewable, and revoked when it is unlinked here.
          subject: linkTokenSubject(machine.id),
        })
        .pipe(Effect.mapError(() => fail("Could not create a pairing link.")));
      const pairingUrl = yield* Effect.try({
        try: () => buildPairingUrl(baseUrl, issued.credential),
        catch: () => fail(`'${baseUrl}' is not an address.`),
      });
      const linked = yield* reach
        .call(
          machine,
          "link.back",
          { pairingUrl },
          { threadId: "", threadTitle: label },
          LinkBackResult,
        )
        .pipe(Effect.mapError((error) => fail(error.detail)));
      return linked;
    });

  const redeemLinkBack: AssistantHomeShape["redeemLinkBack"] = (pairingUrl, from, confirm) =>
    Effect.gen(function* () {
      // The link must lead to the machine that asked, not wherever the body points.
      const target = yield* Effect.try({
        try: () => resolveRemotePairingTarget({ pairingUrl }),
        catch: () => fail("That is not a pairing link."),
      });
      const descriptor = yield* fetchPeerDescriptor(target.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError((error) => fail(error.detail)),
      );
      if (descriptor.environmentId !== from.environmentId) {
        return yield* fail("The pairing link is for a different machine than the one asking.");
      }
      const confirmed = confirm.pipe(Effect.mapError((error) => fail(error.message)));
      const existed = (yield* reach.machines).some((machine) => machine.id === from.environmentId);
      // An existing link whose token was refused (expired or revoked) cannot confirm: relink it,
      // then confirm over the new link. The new link's confirmation would come from whatever
      // server the pairing link names, so a relink must stay at the address this machine already
      // trusts for that machine: a server elsewhere claiming its id cannot take the link over.
      let relinking = false;
      if (existed) {
        const before = yield* Effect.result(confirmed);
        if (before._tag === "Failure") {
          const health = yield* agentMachines.healthOf(from.environmentId);
          if (health.status !== "needs-relink") return yield* before.failure;
          const storedBaseUrl = yield* settingsService.getSettings.pipe(
            Effect.map(
              (settings) => settings.agentPlacement.machines[from.environmentId]?.baseUrl ?? null,
            ),
            Effect.orElseSucceed(() => null),
          );
          if (storedBaseUrl === null || !sameOrigin(storedBaseUrl, target.httpBaseUrl)) {
            return yield* fail(
              `The link back points at a different address than this machine has for ${from.label}. Relink it from this machine instead.`,
            );
          }
          relinking = true;
        }
      }
      const result = yield* agentMachines
        .manage({ action: "link", pairingUrl, expectedId: from.environmentId })
        .pipe(Effect.mapError((error) => fail(error.detail)));
      if (result.linked === undefined) return yield* fail("The link was not saved.");
      const linked = result.linked;
      if (relinking) yield* confirmed;
      if (!existed) {
        // New link: now this machine can ask the one that asked. Undo it unless that machine sent this.
        yield* confirmed.pipe(
          Effect.tapError(() =>
            agentMachines.manage({ action: "unlink", id: linked.id }).pipe(Effect.ignore),
          ),
        );
      }
      return linked;
    });

  const handoff: AssistantHomeShape["handoff"] = (toEnvironmentId) =>
    linkedMachine(toEnvironmentId).pipe(Effect.flatMap(moveFromHere), Effect.asVoid);

  return {
    status,
    manage,
    guardEnsure,
    linkBack,
    adopt,
    commit,
    abort,
    moveStatus,
    handoff,
    yieldTo,
    redeemLinkBack,
    reconcile,
    confirmHome,
  } satisfies AssistantHomeShape;
});

/** Whether two addresses share scheme, host and port. False when either is not a URL. */
export function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export const AssistantHomeLive = Layer.effect(
  AssistantHome,
  Effect.gen(function* () {
    const home = yield* make;
    registerAssistantHomeCheck(home.confirmHome);
    // Finish or undo a move a crash, timeout or sleep interrupted, now and then every minute.
    yield* forkParked(
      Effect.gen(function* () {
        while (true) {
          yield* home.reconcile;
          yield* Effect.sleep(MOVE_RECONCILE_INTERVAL);
        }
      }),
    );
    return home;
  }),
).pipe(Layer.provide(ProjectionProjectRepositoryLive));
