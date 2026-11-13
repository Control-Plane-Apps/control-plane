/**
 * iPhone lock-screen notifications, sent by this Mac straight to APNs.
 * Fork-owned.
 *
 * Sends:
 * - a Status question the moment a coordinator opens (or rewords) it, with an
 *   answer button that sends exactly what the Status panel's answer sends;
 * - agent finished or failed (only at the `all` level);
 * - the Assistant's morning brief once its scheduled turn completes;
 * - task reminders and Assistant pings, through `notifyTaskReminder` and
 *   `notifyAssistantPing`.
 *
 * A notification's buttons carry an action token naming one question version.
 * `runAction` re-checks it against the stored question and the decider refuses
 * the message unless that exact version is still open, so an answer to an
 * outdated question is refused, never sent.
 *
 * @module PushNotifier
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationSessionStatus,
  type ProjectStatus,
  type PushActionRefusal,
  type Task,
  type PushDeviceRegistration,
  type ThreadId,
  recommendationReplyText,
  statusAnswerMessageId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { isOrchestrationCommandRejection } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import {
  issuePushActionToken,
  PUSH_ACTION_SIGNING_SECRET,
  type PushActionClaims,
  verifyPushActionToken,
} from "./actionToken.ts";
import {
  makeApnsClient,
  PERMANENT_APNS_REASONS,
  parseApnsKey,
  type ApnsClient,
} from "./apnsClient.ts";
import {
  EMPTY_PUSH_STORE,
  parsePushStore,
  type PushStoreFile,
  recordSentQuestion,
  removeDevice,
  serializePushStore,
  type StoredPushDevice,
  upsertDevice,
} from "./pushDeviceStore.ts";
import {
  agentFinishedMessage,
  assistantPingMessage,
  type AssistantPingInput,
  formatReminderTime,
  levelAllows,
  type PushMessage,
  pushActionUrl,
  statusQuestionMessage,
  taskReminderMessage,
  type TaskReminderInput,
} from "./pushPayloads.ts";
import { dueTaskReminders, taskReminderKey } from "./taskReminders.ts";

export const MORNING_BRIEF_SCHEDULE_ID = "morning-brief";
const MORNING_BRIEF_BODY_MAX = 200;

export type PushActionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly refusal: PushActionRefusal };

export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly registerDevice: (registration: PushDeviceRegistration) => Effect.Effect<void>;
    /** Runs one notification button. `null` when the token is not valid. */
    readonly runAction: (
      token: string,
      action: "answer" | "complete",
    ) => Effect.Effect<PushActionOutcome | null>;
    readonly notifyTaskReminder: (
      input: Omit<TaskReminderInput, "environmentId">,
    ) => Effect.Effect<void>;
    readonly notifyAssistantPing: (
      input: Omit<AssistantPingInput, "environmentId">,
    ) => Effect.Effect<void>;
    /** Waits for queued sends. Tests use this. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/push/PushNotifier") {}

/** The open question a Status record asks the user, if it should be (re)sent. */
export function questionToSend(
  status: ProjectStatus,
  sentOpenedAt: string | undefined,
): ProjectStatus["decision"] | null {
  const decision = status.decision;
  if (
    status.state !== "needs-you" ||
    decision === undefined ||
    decision.answeredAt !== undefined ||
    decision.deadlineHandled?.outcome === "accepted" ||
    decision.openedAt === sentOpenedAt
  ) {
    return null;
  }
  return decision;
}

const BUSY: ReadonlySet<OrchestrationSessionStatus> = new Set(["starting", "running"]);

/** A session that was working and now is not: finished, failed, or neither. */
export function sessionOutcome(
  previous: OrchestrationSessionStatus | undefined,
  next: OrchestrationSessionStatus,
): "finished" | "failed" | null {
  if (previous === undefined || !BUSY.has(previous) || BUSY.has(next)) return null;
  if (next === "error") return "failed";
  if (next === "ready" || next === "idle") return "finished";
  return null;
}

function isMorningBriefMessage(messageId: string, projectId: string): boolean {
  return messageId.startsWith(`cp-schedule:${projectId}:${MORNING_BRIEF_SCHEDULE_ID}:`);
}

function firstParagraph(text: string, max: number): string {
  const line =
    text
      .split(/\n\s*\n/)
      .map((part) =>
        part
          .replace(/^#+\s*/gm, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((part) => part.length > 0) ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const storePath = path.join(config.stateDir, "push", "devices.json");
  const keyDir = path.join(config.stateDir, "apns");
  const storeLock = yield* Semaphore.make(1);
  const store = yield* Ref.make<PushStoreFile>(
    yield* fs.readFileString(storePath).pipe(
      Effect.map(parsePushStore),
      Effect.orElseSucceed(() => EMPTY_PUSH_STORE),
    ),
  );
  const sessionStatus = new Map<ThreadId, OrchestrationSessionStatus>();
  const tasks = new Map<string, Task>();
  /** Reminders sent this run; a reminder is only sent within its grace window anyway. */
  const sentReminders = new Set<string>();
  let client: ApnsClient | null = null;
  let warnedNoKey = false;

  const updateStore = (f: (current: PushStoreFile) => PushStoreFile) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const next = f(yield* Ref.get(store));
        yield* Ref.set(store, next);
        yield* writeFileStringAtomically({
          filePath: storePath,
          contents: serializePushStore(next),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catchCause((cause) =>
            Effect.logWarning("push: device store write failed", { cause: Cause.pretty(cause) }),
          ),
        );
      }),
    );

  /** Loads the APNs key on first use; a key dropped in later is picked up on the next send. */
  const apns = Effect.gen(function* () {
    if (client !== null) return client;
    const files = yield* fs.readDirectory(keyDir).pipe(Effect.orElseSucceed(() => []));
    for (const fileName of files.toSorted()) {
      const pem = yield* fs
        .readFileString(path.join(keyDir, fileName))
        .pipe(Effect.orElseSucceed(() => ""));
      const key = parseApnsKey({ fileName, pem, teamId: process.env.CP_APNS_TEAM_ID });
      if (key !== null) {
        client = makeApnsClient(key);
        yield* Effect.logInfo("push: APNs key loaded", { keyId: key.keyId });
        return client;
      }
    }
    if (!warnedNoKey) {
      warnedNoKey = true;
      yield* Effect.logWarning(
        `push: no APNs key; put AuthKey_<KEYID>.p8 in ${keyDir} to send iPhone notifications`,
      );
    }
    return null;
  });

  const actionSecret = secrets
    .getOrCreateRandom(PUSH_ACTION_SIGNING_SECRET, 32)
    .pipe(Effect.orElseSucceed(() => null));

  const sendToDevices = (build: (device: StoredPushDevice) => PushMessage | null) =>
    Effect.gen(function* () {
      const devices = (yield* Ref.get(store)).devices;
      if (devices.length === 0) return;
      const sender = yield* apns;
      if (sender === null) return;
      for (const device of devices) {
        const message = build(device);
        if (message === null || !levelAllows(device.level, message.kind)) continue;
        const result = yield* Effect.tryPromise(() =>
          sender.send({
            deviceToken: device.apnsToken,
            environment: device.apsEnvironment,
            topic: device.bundleId,
            collapseId: message.collapseKey,
            payload: message.payload,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("push: send failed", {
              deviceId: device.deviceId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        );
        if (result === null || result.status === 200) continue;
        yield* Effect.logWarning("push: APNs refused", {
          deviceId: device.deviceId,
          status: result.status,
          reason: result.reason,
        });
        if (result.reason !== undefined && PERMANENT_APNS_REASONS.has(result.reason)) {
          yield* updateStore((current) => removeDevice(current, { apnsToken: device.apnsToken }));
        }
      }
    });

  const sendStatusQuestion = (project: OrchestrationProjectShell, status: ProjectStatus) =>
    Effect.gen(function* () {
      const assistant = project.assistant;
      if (assistant == null || assistant.archivedAt != null) return;
      const key = `${project.id}:${status.id}`;
      const decision = questionToSend(status, (yield* Ref.get(store)).sentQuestions[key]);
      if (decision == null) return;
      yield* updateStore((current) => recordSentQuestion(current, key, decision.openedAt));
      const environmentId = yield* environment.getEnvironmentId;
      const secret = yield* actionSecret;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const token =
        secret === null
          ? null
          : issuePushActionToken(
              {
                kind: "push-status-answer",
                projectId: project.id,
                statusId: status.id,
                openedAt: decision.openedAt,
              },
              secret,
              nowMs,
            );
      yield* sendToDevices((device) =>
        statusQuestionMessage(
          {
            environmentId,
            projectId: project.id,
            projectTitle: project.title,
            coordinatorThreadId: assistant.coordinatorThreadId,
            statusId: status.id,
            statusTitle: status.title,
            question: decision.question,
            answerLabel: decision.answer ?? "Go with recommendation",
            openedAt: decision.openedAt,
          },
          token === null ? null : { url: pushActionUrl(device.serverUrl), token },
        ),
      );
    });

  const onStatusUpdated = (projectId: OrchestrationProjectShell["id"], statusId: string) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(projectId));
      const status = project?.assistant?.statuses?.find((entry) => entry.id === statusId);
      if (project === undefined || status === undefined) return;
      yield* sendStatusQuestion(project, status);
    });

  const onSessionSettled = (threadId: ThreadId, outcome: "finished" | "failed") =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
      if (thread === undefined) return;
      const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(thread.projectId));
      if (project === undefined) return;
      const environmentId = yield* environment.getEnvironmentId;
      const isCoordinator = project.assistant?.coordinatorThreadId === threadId;
      if (isCoordinator && outcome === "finished") {
        // The Assistant's morning brief is a `morning-brief` schedule on its
        // Project: the brief is the final reply of the turn that schedule started.
        const detail = Option.getOrUndefined(
          yield* snapshots.getThreadDetailSnapshot(threadId, { turnLimit: 1 }),
        );
        const messages = detail?.thread.messages ?? [];
        const lastUser = messages.findLast((message) => message.role === "user");
        const reply = messages.findLast(
          (message) => message.role === "assistant" && !message.streaming,
        );
        if (
          lastUser !== undefined &&
          reply !== undefined &&
          isMorningBriefMessage(lastUser.id, project.id) &&
          reply.text.trim().length > 0
        ) {
          yield* sendToDevices(() =>
            assistantPingMessage({
              environmentId,
              pingId: lastUser.id,
              title: "Morning brief",
              body: firstParagraph(reply.text, MORNING_BRIEF_BODY_MAX),
              threadId,
            }),
          );
        }
      }
      // A coordinator's own turns surface through Status; its agents are what finish.
      if (isCoordinator) return;
      yield* sendToDevices(() =>
        agentFinishedMessage({
          environmentId,
          threadId,
          threadTitle: thread.title,
          projectTitle: project.title,
          failed: outcome === "failed",
        }),
      );
    });

  const isolated = <E>(label: string, effect: Effect.Effect<void, E>): Effect.Effect<void> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(`push: ${label} failed`, { cause: Cause.pretty(cause) }),
      ),
    );

  const pending = yield* Ref.make(0);
  const processEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "project.status-updated":
        return isolated(
          "status question",
          onStatusUpdated(event.payload.projectId, event.payload.statusId),
        );
      case "thread.session-set": {
        const threadId = event.payload.threadId;
        const next = event.payload.session.status;
        const outcome = sessionOutcome(sessionStatus.get(threadId), next);
        sessionStatus.set(threadId, next);
        return outcome === null
          ? Effect.void
          : isolated("agent finished", onSessionSettled(threadId, outcome));
      }
      case "thread.deleted":
        sessionStatus.delete(event.payload.threadId);
        return Effect.void;
      case "task.updated":
        if (event.payload.task === null) tasks.delete(event.payload.taskId);
        else tasks.set(event.payload.taskId, event.payload.task);
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  const sweepReminders = isolated(
    "task reminders",
    Effect.gen(function* () {
      if (tasks.size === 0) return;
      const due = dueTaskReminders(
        tasks.values(),
        DateTime.toEpochMillis(yield* DateTime.now),
        sentReminders,
      );
      for (const task of due) {
        const key = taskReminderKey(task);
        if (key !== null) sentReminders.add(key);
        if (task.home.kind !== "date" || task.home.reminderTime === undefined) continue;
        yield* notifyTaskReminder({
          taskId: task.id,
          title: task.title,
          detail: task.notes ?? `Due ${formatReminderTime(task.home.reminderTime)}`,
          ...(task.links?.threadId === undefined ? {} : { threadId: task.links.threadId }),
        });
      }
    }),
  );

  const start: PushNotifier["Service"]["start"] = Effect.fn("PushNotifier.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const shell = yield* snapshots
      .getShellSnapshot({ unsettledOnly: true })
      .pipe(Effect.orElseSucceed(() => null));
    for (const task of shell?.tasks ?? []) tasks.set(task.id, task);
    yield* forkParked(
      sweepReminders.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        Ref.update(pending, (n) => n + 1).pipe(
          Effect.andThen(processEvent(event)),
          Effect.ensuring(Ref.update(pending, (n) => n - 1)),
        ),
      ),
    );
  });

  const registerDevice: PushNotifier["Service"]["registerDevice"] = (registration) =>
    Effect.gen(function* () {
      if (registration.enabled === false || registration.level === "off") {
        yield* updateStore((current) =>
          removeDevice(current, {
            deviceId: registration.deviceId,
            apnsToken: registration.apnsToken,
          }),
        );
        return;
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* updateStore((current) =>
        upsertDevice(current, {
          deviceId: registration.deviceId,
          apnsToken: registration.apnsToken.toLowerCase(),
          apsEnvironment: registration.apsEnvironment,
          bundleId: registration.bundleId,
          serverUrl: registration.serverUrl,
          level: registration.level,
          ...(registration.label === undefined ? {} : { label: registration.label }),
          updatedAt,
        }),
      );
    });

  const answerStatus = (claims: Extract<PushActionClaims, { kind: "push-status-answer" }>) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(
        yield* snapshots
          .getProjectShellById(claims.projectId as OrchestrationProjectShell["id"])
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      const assistant = project?.assistant;
      const status = assistant?.statuses?.find((entry) => entry.id === claims.statusId);
      const decision = status?.decision;
      if (project === undefined || assistant == null || status === undefined) {
        return { ok: false, status: 404, refusal: "not-found" } as const;
      }
      if (decision === undefined || decision.openedAt !== claims.openedAt) {
        return { ok: false, status: 409, refusal: "outdated" } as const;
      }
      if (decision.answeredAt !== undefined || status.state !== "needs-you") {
        return { ok: false, status: 409, refusal: "answered" } as const;
      }
      const messageId = statusAnswerMessageId(project.id, status.id, decision.openedAt);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      // The decider re-checks the version against the stored question, so a
      // rewording that lands between this read and the dispatch is refused too.
      return yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(messageId),
          threadId: assistant.coordinatorThreadId,
          message: {
            messageId: MessageId.make(messageId),
            text: recommendationReplyText(status, decision),
            attachments: [],
          },
          createdAt,
        })
        .pipe(
          Effect.as({ ok: true } as const),
          Effect.catchIf(isOrchestrationCommandRejection, (error) =>
            Effect.logInfo("push: status answer refused", {
              projectId: project.id,
              statusId: status.id,
              detail: error.message,
            }).pipe(Effect.as({ ok: false, status: 409, refusal: "outdated" } as const)),
          ),
        );
    });

  const completeTask = (taskId: string) =>
    Effect.gen(function* () {
      const task = tasks.get(taskId);
      if (task === undefined) return { ok: false, status: 404, refusal: "not-found" } as const;
      if (task.status !== "todo") {
        return { ok: false, status: 409, refusal: "answered" } as const;
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      return yield* engine
        .dispatch({
          type: "task.update",
          commandId: CommandId.make(`cp-push-task:${taskId}:${Date.parse(task.updatedAt)}`),
          taskId: task.id,
          patch: { status: "completed" },
          createdAt,
        })
        .pipe(
          Effect.as({ ok: true } as const),
          Effect.catchIf(isOrchestrationCommandRejection, () =>
            Effect.succeed({ ok: false, status: 409, refusal: "outdated" } as const),
          ),
        );
    });

  const runAction: PushNotifier["Service"]["runAction"] = (token, action) =>
    Effect.gen(function* () {
      const secret = yield* actionSecret;
      if (secret === null) return null;
      const claims = verifyPushActionToken(
        token,
        secret,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      if (claims === null) return null;
      if (claims.kind === "push-status-answer" && action === "answer") {
        return yield* answerStatus(claims);
      }
      if (claims.kind === "push-task-complete" && action === "complete") {
        return yield* completeTask(claims.taskId);
      }
      return { ok: false, status: 400, refusal: "unsupported" } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push: action failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as({ ok: false, status: 500, refusal: "unsupported" } as const),
        ),
      ),
    );

  const notifyTaskReminder: PushNotifier["Service"]["notifyTaskReminder"] = (input) =>
    isolated(
      "task reminder",
      Effect.gen(function* () {
        const environmentId = yield* environment.getEnvironmentId;
        const secret = yield* actionSecret;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const token =
          secret === null
            ? null
            : issuePushActionToken(
                { kind: "push-task-complete", taskId: input.taskId },
                secret,
                nowMs,
              );
        yield* sendToDevices((device) =>
          taskReminderMessage(
            { ...input, environmentId },
            token === null ? null : { url: pushActionUrl(device.serverUrl), token },
          ),
        );
      }),
    );

  const notifyAssistantPing: PushNotifier["Service"]["notifyAssistantPing"] = (input) =>
    isolated(
      "assistant ping",
      Effect.gen(function* () {
        const environmentId = yield* environment.getEnvironmentId;
        yield* sendToDevices(() => assistantPingMessage({ ...input, environmentId }));
      }),
    );

  yield* Effect.addFinalizer(() => Effect.sync(() => client?.close()));

  return {
    start,
    registerDevice,
    runAction,
    notifyTaskReminder,
    notifyAssistantPing,
    drain: Effect.gen(function* () {
      while ((yield* Ref.get(pending)) > 0) yield* Effect.yieldNow;
    }),
  } satisfies PushNotifier["Service"];
});

export const layer = Layer.effect(PushNotifier, make);
