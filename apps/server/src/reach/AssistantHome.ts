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
import { ensureAssistant } from "../assistant/ensureAssistant.ts";
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
import { makeMoveJournal, type SourceMove, type TargetMove } from "./assistantMoves.ts";
import { fetchPeerDescriptor } from "../agentMachines/AgentMachineClient.ts";
import { forkParked } from "../serverActivation.ts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AdoptResult,
  DescribeResult,
  MoveStatusResult,
  LinkBackResult,
  type AssistantBundle,
  type OverviewResult,
} from "./reachProtocol.ts";
import { knownAssistantHost, noteAssistantHost, refreshTaskAuthority } from "./taskAuthority.ts";

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
  readonly commit: (moveId: string) => Effect.Effect<MoveStatus, AssistantHomeError>;
  readonly abort: (moveId: string, from: MovePeer) => Effect.Effect<MoveStatus, AssistantHomeError>;
  readonly moveStatus: (moveId: string) => Effect.Effect<MoveStatus>;
  readonly handoff: (toEnvironmentId: string) => Effect.Effect<void, AssistantHomeError>;
  readonly redeemLinkBack: (
    pairingUrl: string,
    from: MovePeer,
  ) => Effect.Effect<{ readonly id: string; readonly label: string }, AssistantHomeError>;
  /** Finishes or undoes interrupted moves; runs at start and every minute. */
  readonly reconcile: Effect.Effect<void>;
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
  const journal = yield* makeMoveJournal(config.stateDir);

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
        noteAssistantHost(machine.id, {
          hosts: described.success.assistant !== null,
          at: DateTime.toEpochMillis(yield* DateTime.now),
        });
        return {
          id: machine.id,
          label: machine.label,
          state: "online",
          hostsAssistant: described.success.assistant !== null,
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
        hostsAssistant:
          knownAssistantHost(machine.id, DateTime.toEpochMillis(yield* DateTime.now)) ?? null,
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
    return {
      here: project !== undefined,
      ...(pending !== undefined
        ? { pendingMove: { label: pending.peerLabel, startedAt: pending.startedAt } }
        : {}),
      elsewhere: project === undefined ? (hosts[0] ?? null) : null,
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
          return { projectId: known.value.projectId, threadId: known.value.threadId };
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
        const home =
          archived !== undefined
            ? yield* Effect.gen(function* () {
                // A fresh coordinator thread in the archived Project: the conversation
                // lands in an empty thread, and the old one stays as history.
                const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
                yield* dispatch(
                  {
                    type: "thread.create",
                    commandId: CommandId.make(`assistant-home:thread:${bundle.moveId}`),
                    threadId,
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
                    commandId: CommandId.make(`assistant-home:coordinator:${bundle.moveId}`),
                    projectId: archived.project.id,
                    assistant: { coordinatorThreadId: threadId, archived: true },
                  },
                  "Could not prepare the Assistant here",
                );
                return {
                  projectId: archived.project.id as string,
                  threadId: threadId as string,
                  created: false,
                  previousThreadId: archived.threadId as string,
                };
              })
            : yield* ensureAssistant({
                stateDir: config.stateDir,
                request: { modelSelection, runtimeMode },
                engine,
                snapshots,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.mapError((error) => fail(error.message)),
                Effect.map((made) => ({
                  projectId: made.projectId as string,
                  threadId: made.threadId as string,
                  created: true,
                  previousThreadId: undefined,
                })),
              );
        // Paused until the source commits: never live alongside the source's copy.
        if (home.created) yield* setArchived(home.projectId, home.threadId, true);
        const record: TargetMove = {
          role: "target",
          moveId: bundle.moveId,
          peerId: from.environmentId,
          peerLabel: from.label,
          phase: "adopted",
          projectId: home.projectId,
          threadId: home.threadId,
          created: home.created,
          ...(home.previousThreadId !== undefined
            ? { previousThreadId: home.previousThreadId }
            : {}),
          previousSettings,
          previousMemory,
          asks: bundle.asks,
          startedAt: yield* nowIso,
        };
        const steps = Effect.gen(function* () {
          const settings = yield* decodeAssistantSettings(bundle.settings).pipe(
            Effect.mapError(() => fail("The Assistant's settings could not be read.")),
          );
          yield* journal.put(record);
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
                commandId: CommandId.make(`assistant-home:schedules:${bundle.moveId}`),
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
                commandId: CommandId.make(`assistant-home:history:${bundle.moveId}`),
                threadId: ThreadId.make(home.threadId),
                messages: [first, ...rest],
              },
              "Could not bring the conversation over",
            );
          }
        });
        yield* steps.pipe(Effect.tapError(() => abortTarget(record)));
        return { projectId: home.projectId, threadId: home.threadId } satisfies AdoptResult;
      }),
    );

  /** Undoes an adopted copy: settings and memory back as they were, a made project deleted. */
  const abortTarget = (record: TargetMove) =>
    Effect.gen(function* () {
      const previous = yield* decodeAssistantSettings(record.previousSettings).pipe(Effect.option);
      if (previous._tag === "Some") {
        yield* settingsService.updateSettings({ assistant: previous.value }).pipe(Effect.ignore);
      }
      if (record.previousMemory !== null) {
        yield* fileSystem.writeFileString(memoryPath, record.previousMemory).pipe(Effect.ignore);
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
      yield* journal.put({ ...record, phase: "aborted" });
    });

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
        if (known.value.phase === "committed") {
          return yield* fail("That move already finished; move the Assistant back instead.");
        }
        if (known.value.phase === "adopted") yield* abortTarget(known.value);
        return { phase: "aborted" as const };
      }),
    );

  const commit: AssistantHomeShape["commit"] = (moveId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const known = yield* journal.getTarget(moveId);
        if (Option.isNone(known) || known.value.phase === "aborted") {
          return yield* fail("There is no such move to finish here.");
        }
        const record = known.value;
        if (record.phase === "committed") return { phase: "committed" as const };
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
    journal
      .get(moveId, "target")
      .pipe(
        Effect.map((known) =>
          Option.isNone(known)
            ? ({ phase: "unknown" } as const)
            : ({ phase: known.value.phase } as MoveStatus),
        ),
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
          if (record.role !== "source") continue;
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

  const guardEnsure = Effect.gen(function* () {
    const { project } = yield* localAssistant;
    if (project !== undefined) return;
    for (const machine of yield* reach.machines) {
      if (knownAssistantHost(machine.id, DateTime.toEpochMillis(yield* DateTime.now)) === true) {
        const health = yield* reach.healthOf(machine.id);
        const offline = health.status !== "connected" && health.status !== "unknown";
        return yield* fail(
          `Your Assistant runs on ${machine.label}${offline ? ", which is offline" : ""}. Open it there, or move it here in Settings, Assistant.`,
        );
      }
    }
  });

  const linkBack: AssistantHomeShape["linkBack"] = ({ id, baseUrl }) =>
    Effect.gen(function* () {
      const machine = yield* linkedMachine(id);
      const label = (yield* environment.getDescriptor).label;
      const issued = yield* auth
        .createPairingLink({
          ttl: Duration.minutes(10),
          label: `Link back from ${machine.label}`,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
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

  const redeemLinkBack: AssistantHomeShape["redeemLinkBack"] = (pairingUrl, from) =>
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
    }).pipe(
      Effect.andThen(agentMachines.manage({ action: "link", pairingUrl })),
      Effect.mapError((error) => fail(error.detail)),
      Effect.flatMap((result) =>
        result.linked === undefined
          ? Effect.fail(fail("The link was not saved."))
          : Effect.succeed(result.linked),
      ),
    );

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
    redeemLinkBack,
    reconcile,
  } satisfies AssistantHomeShape;
});

export const AssistantHomeLive = Layer.effect(
  AssistantHome,
  Effect.gen(function* () {
    const home = yield* make;
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
