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
import { ReachBridge } from "./ReachBridge.ts";
import {
  AdoptResult,
  DescribeResult,
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
    from: { readonly label: string },
  ) => Effect.Effect<AdoptResult, AssistantHomeError>;
  readonly handoff: (toEnvironmentId: string) => Effect.Effect<void, AssistantHomeError>;
  readonly redeemLinkBack: (
    pairingUrl: string,
  ) => Effect.Effect<{ readonly id: string; readonly label: string }, AssistantHomeError>;
}

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
    handoff: () => unavailable,
    redeemLinkBack: () => unavailable,
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
  const lock = yield* Semaphore.make(1);

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
        noteAssistantHost(machine.id, described.success.assistant !== null);
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
        hostsAssistant: knownAssistantHost(machine.id) ?? null,
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
    return {
      here: project !== undefined,
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

  /** Collects everything that moves. */
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
      const schedules = (marker?.schedules ?? [])
        // A schedule aimed at one of the Assistant's other threads cannot move with it.
        .filter((schedule) => schedule.target === "coordinator" || schedule.target === threadId)
        .map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          cron: schedule.cron,
          enabled: schedule.enabled,
          prompt: Object.hasOwn(prompts, schedule.id) ? (prompts[schedule.id] ?? "") : "",
        }));
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
      return {
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
    });

  const setArchived = (projectId: ProjectId, coordinatorThreadId: ThreadId, archived: boolean) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.flatMap((uuid) =>
        dispatch(
          {
            type: "project.meta.update",
            commandId: CommandId.make(
              `assistant-home:${archived ? "archive" : "restore"}:${projectId}:${uuid}`,
            ),
            projectId,
            assistant: { coordinatorThreadId, archived },
          },
          archived ? "Could not pause the Assistant here" : "Could not restore the Assistant here",
        ),
      ),
    );

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
        const bundle = yield* bundleOf(project, thread.id, moveId);
        // Paused here first: from now until the target adopts, no machine runs one.
        yield* setArchived(project.id, thread.id, true);
        const label = (yield* environment.getDescriptor).label;
        const adopted = yield* reach
          .call(
            machine,
            "assistant.adopt",
            bundle,
            { threadId: thread.id, threadTitle: label },
            AdoptResult,
          )
          .pipe(Effect.result);
        if (adopted._tag === "Failure") {
          yield* setArchived(project.id, thread.id, false);
          return yield* fail(`Not moved: ${adopted.failure.detail}`);
        }
        yield* bridge.dropFor(thread.id);
        noteAssistantHost(machine.id, true);
        yield* dispatch(
          {
            type: "thread.activity.append",
            commandId: CommandId.make(`assistant-home:moved:${moveId}`),
            threadId: thread.id,
            activity: {
              id: EventId.make(`assistant-home:moved:${moveId}`),
              tone: "info",
              kind: "assistant.moved",
              summary: `Assistant moved to ${machine.label}`,
              payload: {
                detail: `This copy is read-only. Your Assistant now runs on ${machine.label}.`,
              },
              turnId: null,
              createdAt: yield* nowIso,
            },
            createdAt: yield* nowIso,
          },
          "Moved, but the note was not recorded",
        ).pipe(Effect.ignore);
        yield* refreshTaskAuthority;
      }),
    );

  const adopt: AssistantHomeShape["adopt"] = (bundle, from) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
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
        const created = yield* ensureAssistant({
          stateDir: config.stateDir,
          request: { modelSelection, runtimeMode },
          engine,
          snapshots,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((error) => fail(error.message)),
        );
        const projectId = created.projectId;
        const threadId = created.threadId;
        const undo = setArchived(projectId, threadId, true).pipe(Effect.ignore);
        const steps = Effect.gen(function* () {
          const settings = yield* decodeAssistantSettings(bundle.settings).pipe(
            Effect.mapError(() => fail("The Assistant's settings could not be read.")),
          );
          yield* settingsService
            .updateSettings({ assistant: settings })
            .pipe(Effect.mapError(() => fail("Could not save the Assistant's settings.")));
          if (bundle.schedules.length > 0) {
            yield* dispatch(
              {
                type: "project.meta.update",
                commandId: CommandId.make(`assistant-home:schedules:${bundle.moveId}`),
                projectId,
                assistant: {
                  coordinatorThreadId: threadId,
                  schedules: bundle.schedules.map((schedule) => ({
                    id: schedule.id,
                    name: schedule.name,
                    cron: schedule.cron,
                    target: "coordinator" as const,
                    enabled: schedule.enabled,
                    prompt: schedule.prompt,
                  })),
                },
              },
              "Could not recreate the Assistant's schedules",
            );
          }
          if (bundle.memory !== null) {
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
                threadId,
                messages: [first, ...rest],
              },
              "Could not bring the conversation over",
            );
          }
          const now = yield* nowIso;
          for (const ask of bundle.asks) yield* bridge.track({ ...ask, replyTo: threadId });
          yield* dispatch(
            {
              type: "thread.activity.append",
              commandId: CommandId.make(`assistant-home:arrived:${bundle.moveId}`),
              threadId: ThreadId.make(threadId),
              activity: {
                id: EventId.make(`assistant-home:arrived:${bundle.moveId}`),
                tone: "info",
                kind: "assistant.moved",
                summary: `Assistant moved here from ${from.label}`,
                payload: {
                  detail: `Settings, schedules, memory and the last ${moved.length} messages came with it.`,
                },
                turnId: null,
                createdAt: now,
              },
              createdAt: now,
            },
            "Could not record the move",
          ).pipe(Effect.ignore);
        });
        yield* steps.pipe(Effect.tapError(() => undo));
        // Answer first; the old home refreshes after it hears back.
        yield* Effect.forkDetach(refreshTaskAuthority);
        return { projectId, threadId } satisfies AdoptResult;
      }),
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
      yield* moveFromHere(yield* linkedMachine(input.to));
      return yield* status;
    });

  const guardEnsure = Effect.gen(function* () {
    const { project } = yield* localAssistant;
    if (project !== undefined) return;
    for (const machine of yield* reach.machines) {
      if (knownAssistantHost(machine.id) === true) {
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

  const redeemLinkBack: AssistantHomeShape["redeemLinkBack"] = (pairingUrl) =>
    agentMachines.manage({ action: "link", pairingUrl }).pipe(
      Effect.mapError((error) => fail(error.detail)),
      Effect.flatMap((result) =>
        result.linked === undefined
          ? Effect.fail(fail("The link was not saved."))
          : Effect.succeed(result.linked),
      ),
    );

  const handoff: AssistantHomeShape["handoff"] = (toEnvironmentId) =>
    linkedMachine(toEnvironmentId).pipe(Effect.flatMap(moveFromHere));

  return {
    status,
    manage,
    guardEnsure,
    linkBack,
    adopt,
    handoff,
    redeemLinkBack,
  } satisfies AssistantHomeShape;
});

export const AssistantHomeLive = Layer.effect(AssistantHome, make).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);
