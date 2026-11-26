// @effect-diagnostics nodeBuiltinImport:off - portable file snapshots require no-follow file descriptors and atomic renames.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProjectMoveBundle,
  HistoricalOrchestrationEvent,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { HostTimeZoneSource } from "../schedules/hostZone.ts";
import { RemoteAgentStore } from "../agentMachines/RemoteAgentStore.ts";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { projectMoveFenceOwner, withProjectMovePermit } from "./projectMoveFence.ts";
import { sha256Hex } from "./assistantHistory.ts";

const encodeBundleJson = Schema.encodeEffect(Schema.fromJsonString(ProjectMoveBundle));
const decodeBundle = Schema.decodeEffect(ProjectMoveBundle);
const encodeHistoricalEvent = Schema.encodeSync(HistoricalOrchestrationEvent);

const LIMIT = 60 * 1024 * 1024;
const MAX_EVENTS = 100_000;
class ProjectMoveDataError extends Data.TaggedError("ProjectMoveDataError")<{
  readonly message: string;
}> {}
const fail = (message: string) => new ProjectMoveDataError({ message });
const io = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
  });
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const hash = (value: unknown) => sha256Hex(Buffer.from(canonicalJson(value)));

async function readFile(file: string): Promise<Buffer | null> {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT)
      throw fail("Unsupported or oversized Project move file.");
    const content = await handle.readFile();
    if (content.length > LIMIT) throw fail("Project move file exceeds the transfer limit.");
    return content;
  } finally {
    await handle.close();
  }
}

async function replaceFile(file: string, bytes: Buffer | null) {
  const before = await readFile(file);
  if (before === null ? bytes === null : bytes !== null && bytes.equals(before)) return;
  if (bytes === null) {
    await NodeFSP.unlink(file);
    return;
  }
  const temp = NodePath.join(NodePath.dirname(file), `.cp-move-${NodeCrypto.randomUUID()}`);
  try {
    await NodeFSP.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temp, file);
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
}

/**
 * Keep a private hard link until readback on the returning source, or until
 * rollback on the destination. A crash before
 * the SQL import commits leaves proof of exactly which attachment we created.
 * Existing matching files never acquire a proof link.
 */
async function stageAttachment(directory: string, target: string, bytes: Buffer) {
  const existing = await readFile(target);
  if (existing) {
    if (!existing.equals(bytes)) throw fail("An attachment identity collides on the destination.");
    return;
  }
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await NodeFSP.lstat(directory)).isDirectory())
    throw fail("Invalid move staging directory.");
  const staged = NodePath.join(directory, NodePath.basename(target));
  await replaceFile(staged, bytes);
  try {
    await NodeFSP.link(staged, target);
  } catch (cause) {
    if (
      (cause as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await readFile(target))?.equals(bytes)
    )
      throw cause;
  }
}

async function finishAttachments(
  directory: string,
  retained: ReadonlySet<string>,
  cleanup: boolean,
) {
  let entries;
  try {
    if (!(await NodeFSP.lstat(directory)).isDirectory())
      throw fail("Invalid move staging directory.");
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    if (!entry.isFile()) throw fail("Unrecognized file in the move staging directory.");
    const staged = NodePath.join(directory, entry.name);
    if (cleanup && !retained.has(entry.name) && !entry.name.startsWith(".cp-move-")) {
      const target = NodePath.join(NodePath.dirname(directory), entry.name);
      const current = await NodeFSP.lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
        return null;
      });
      const proof = await NodeFSP.lstat(staged);
      if (current?.isFile() && current.ino === proof.ino && current.dev === proof.dev)
        await NodeFSP.unlink(target);
    }
    await NodeFSP.unlink(staged);
  }
  await NodeFSP.rmdir(directory);
}

const normalize = (
  event: HistoricalOrchestrationEvent,
  projectId: ProjectId,
): HistoricalOrchestrationEvent =>
  event.type === "thread.created"
    ? { ...event, sequence: 0, payload: { ...event.payload, projectId } }
    : { ...event, sequence: 0 };

const portableId = ProjectId.make("portable-project");
export const projectMoveDigest = (bundle: ProjectMoveBundle) =>
  hash({
    ...bundle,
    zone: bundle.project.assistant?.schedules?.length ? bundle.zone : null,
    project: { ...bundle.project, projectId: portableId },
    receipts: bundle.receipts.map((r) => ({
      ...r,
      aggregateId: r.aggregateKind === "project" ? portableId : r.aggregateId,
    })),
    threads: bundle.threads.map((thread) => ({
      ...thread,
      events: thread.events.map((event) => normalize(event, portableId)),
    })),
  });

function attachmentPath(root: string, id: string, file: ChatAttachment) {
  const segment = toSafeThreadAttachmentSegment(id);
  const target = resolveAttachmentPath({ attachmentsDir: root, attachment: file });
  if (!target || !segment || parseThreadSegmentFromAttachmentId(file.id) !== segment)
    throw fail("An attachment does not belong to the moving thread.");
  return target;
}

function eventAttachments(event: HistoricalOrchestrationEvent) {
  if (event.type === "thread.message-sent") return event.payload.attachments ?? [];
  if (event.type === "thread.user-input-response-requested")
    return Object.values(event.payload.attachmentsByQuestionId ?? {}).flat();
  return [];
}

function rolePath(root: string, key: string) {
  if (key !== "AGENTS.md" && !/^[a-z0-9-]+\/AGENTS\.md$/.test(key))
    throw fail("Invalid Project role file.");
  return NodePath.join(root, key);
}

async function readRoles(root: string) {
  const roles: Record<string, string> = {};
  const keys = ["AGENTS.md"];
  for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
    if (/^[a-z0-9-]+$/.test(entry.name) && entry.isDirectory())
      keys.push(`${entry.name}/AGENTS.md`);
  }
  for (const key of keys.sort()) {
    const content = await readFile(rolePath(root, key));
    if (content) roles[key] = content.toString("base64");
  }
  return roles;
}

export const makeProjectMoveData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionProjectRepository;
  const config = yield* ServerConfig;
  const timeZone = yield* HostTimeZoneSource;
  type Receipt = ProjectMoveBundle["receipts"][number];
  const executionReceipts = (id: string) => sql<Receipt>`
    SELECT command_id AS commandId, aggregate_kind AS aggregateKind, aggregate_id AS aggregateId,
      accepted_at AS acceptedAt, status, error FROM orchestration_command_receipts
    WHERE (aggregate_kind='project' AND aggregate_id=${id}
        AND (command_id GLOB 'cp-schedule-run:*' OR command_id GLOB 'cp-status:*'))
       OR (aggregate_kind='thread' AND aggregate_id IN (
         SELECT thread_id FROM projection_threads WHERE project_id=${id}))
    ORDER BY command_id`;
  const remoteStore = yield* RemoteAgentStore;

  const projectOf = (id: string) =>
    Effect.gen(function* () {
      const project = Option.getOrNull(yield* projects.getById({ projectId: ProjectId.make(id) }));
      if (!project || project.deletedAt || project.assistant?.scope === "global")
        return yield* Effect.fail(fail("Select a registered workspace or an ordinary Project."));
      return project;
    });

  const capture = Effect.fn("projectMove.capture")(function* (id: string) {
    const project = yield* projectOf(id);
    if ((yield* remoteStore.listForMove).some((a) => a.homeProjectId === id)) {
      return yield* Effect.fail(
        fail("An agent placement needs verified routing on its original machine."),
      );
    }
    const head = yield* engine.latestSequence;
    const ids = yield* sql<{ thread_id: string; deleted_at: string | null }>`
      SELECT thread_id, deleted_at FROM projection_threads WHERE project_id = ${id} ORDER BY thread_id
    `;
    const threads: ProjectMoveBundle["threads"][number][] = [];
    const attachments = new Map<string, ProjectMoveBundle["attachments"][number]>();
    let size = 0;
    for (const row of ids) {
      const threadId = ThreadId.make(row.thread_id);
      const [retired] = yield* sql<{
        seq: number;
      }>`SELECT COALESCE(MAX(sequence),0) AS seq FROM orchestration_events
        WHERE aggregate_kind='thread' AND stream_id=${threadId} AND event_type='thread.deleted'
          AND substr(command_id,1,19)='cp-project-cleanup:'`;
      const range = {
        threadId,
        fromSequenceExclusive: retired?.seq ?? 0,
        toSequenceInclusive: head,
      };
      const stats = yield* engine.getThreadReplayStats({ ...range, maxEvents: MAX_EVENTS });
      if (row.deleted_at && !stats.eventCount && retired?.seq) continue;
      size += stats.payloadBytes;
      if (size > LIMIT || stats.eventCount > MAX_EVENTS)
        return yield* Effect.fail(fail("Project history exceeds the move transfer limit."));
      const shell = Option.getOrNull(yield* snapshots.getThreadShellById(threadId));
      if (shell?.backgroundLiveness || shell?.hasPendingUserInput || shell?.hasPendingApprovals)
        return yield* Effect.fail(
          fail(
            "Wait for background work and resolve pending approvals or user input before moving.",
          ),
        );
      const detail = row.deleted_at
        ? null
        : Option.getOrNull(
            yield* snapshots.getThreadDetailById(threadId, { includeArchived: true }),
          );
      if (
        (!detail && !row.deleted_at) ||
        detail?.worktreePath != null ||
        detail?.session?.activeTurnId ||
        detail?.session?.status === "running" ||
        detail?.session?.status === "starting"
      )
        return yield* Effect.fail(
          fail("A Project thread requires its original worktree or still has an active turn."),
        );
      const events: HistoricalOrchestrationEvent[] = [];
      for (const persisted of yield* Stream.runCollect(
        engine.readThreadEvents({ ...range, limit: MAX_EVENTS }),
      )) {
        const event = normalize(
          persisted.type === "thread.history-restored" ? persisted.payload.event : persisted,
          project.projectId,
        );
        if ("worktreePath" in event.payload && event.payload.worktreePath != null)
          return yield* Effect.fail(fail("A Project thread references an original worktree."));
        if (
          !row.deleted_at &&
          event.type === "thread.message-sent" &&
          event.payload.source?.kind === "agent" &&
          event.payload.source.placementHome
        )
          return yield* Effect.fail(
            fail("A local thread still belongs to a coordinator on another machine."),
          );
        if (
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind.startsWith("agent.handoff.")
        )
          return yield* Effect.fail(
            fail("An agent handoff requires verified routing on its original machine."),
          );
        events.push(event);
        if (row.deleted_at) continue;
        for (const file of eventAttachments(event)) {
          if (attachments.has(file.id)) continue;
          const data = yield* io(() =>
            readFile(attachmentPath(config.attachmentsDir, threadId, file)),
          );
          if (!data || data.length !== file.sizeBytes)
            return yield* Effect.fail(fail("A historical attachment is missing or incomplete."));
          size += Math.ceil((data.length * 4) / 3);
          if (size > LIMIT)
            return yield* Effect.fail(fail("Project attachments exceed the move transfer limit."));
          attachments.set(file.id, {
            threadId,
            file,
            bytes: data.toString("base64"),
            sha256: sha256Hex(data),
          });
        }
      }
      if (events[0]?.type !== "thread.created")
        return yield* Effect.fail(fail("A thread creation event is missing."));
      threads.push({
        id: threadId,
        events,
        projectionDigest:
          detail === null
            ? hash({ id: threadId, deletedAt: row.deleted_at })
            : hash({
                ...detail,
                projectId: portableId,
                activities: detail.activities.map(({ sequence: _seq, ...rest }) => rest),
              }),
      });
    }
    const {
      projectId,
      title,
      defaultModelSelection,
      defaultThreadEnvMode,
      autoPull,
      faviconPath,
      projectIcon,
      orderKey,
      scripts,
      updatedAt,
    } = project;
    const memory = yield* io(() => readFile(NodePath.join(project.workspaceRoot, "MEMORY.md")));
    const bundle: ProjectMoveBundle = {
      version: 1,
      coordinator: project.assistant?.coordinatorThreadId ?? null,
      project: {
        projectId,
        title,
        defaultModelSelection,
        defaultThreadEnvMode,
        autoPull,
        faviconPath,
        projectIcon,
        orderKey,
        scripts,
        assistant: project.assistant
          ? { ...project.assistant, scheduleProjectId: project.assistant.scheduleProjectId ?? id }
          : null,
        updatedAt,
      },
      threads,
      receipts: yield* executionReceipts(id),
      attachments: [...attachments.values()].sort((a, b) => a.file.id.localeCompare(b.file.id)),
      memory: memory?.toString("base64") ?? null,
      roles: yield* io(() => readRoles(project.workspaceRoot)),
      zone: timeZone().zone,
    };
    if (Buffer.byteLength(yield* encodeBundleJson(bundle)) > LIMIT)
      return yield* Effect.fail(fail("Project snapshot exceeds the transfer limit."));
    return bundle;
  });

  const install = Effect.fn("projectMove.install")(function* (
    id: string,
    moveId: string,
    input: ProjectMoveBundle,
    cleanupDigest?: string,
    retainAttachmentProof = false,
  ) {
    if ((yield* projectMoveFenceOwner(sql, id)) !== moveId)
      return yield* Effect.fail(fail("The Project move fence is missing."));
    const bundle = yield* decodeBundle(input);
    const stagingDirectory = NodePath.join(
      config.attachmentsDir,
      ".cp-project-move-" + hash([id, moveId]),
    );
    const retainedAttachments = new Set<string>();
    const project = yield* projectOf(id);
    const before = yield* capture(id);
    const projectId = project.projectId;
    if (
      bundle.project.assistant?.scope === "global" ||
      bundle.coordinator !== (bundle.project.assistant?.coordinatorThreadId ?? null) ||
      (bundle.coordinator !== null && !bundle.threads.some((t) => t.id === bundle.coordinator)) ||
      (bundle.project.assistant?.schedules?.length && bundle.zone !== before.zone)
    )
      return yield* Effect.fail(fail("Incompatible coordinator or schedule time zone."));
    const byId = new Map(before.threads.map((t) => [t.id, t]));
    const targetIds = new Set(bundle.threads.map((t) => t.id));
    const pending: HistoricalOrchestrationEvent[] = [];
    if (targetIds.size !== bundle.threads.length)
      return yield* Effect.fail(fail("Duplicate Project thread id."));
    for (const thread of bundle.threads) {
      const old = byId.get(thread.id);
      const ownership = yield* sql<{
        project_id: string;
      }>`SELECT project_id FROM projection_threads WHERE thread_id = ${thread.id}`;
      const [last] =
        !old && ownership.length
          ? yield* sql<{ retired: number }>`
        SELECT event_type='thread.deleted' AND substr(command_id,1,19)='cp-project-cleanup:' AS retired
        FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${thread.id} ORDER BY sequence DESC LIMIT 1`
          : [];
      if (
        ownership.some((row) => row.project_id !== id) ||
        (!old && ownership.length && !last?.retired)
      )
        return yield* Effect.fail(fail("A thread identity collides on the destination."));
      if (
        thread.events[0]?.type !== "thread.created" ||
        (old && old.events.length > thread.events.length)
      )
        return yield* Effect.fail(fail("The two thread histories diverged."));
      for (const [i, event] of thread.events.entries()) {
        if (
          event.aggregateKind !== "thread" ||
          event.aggregateId !== thread.id ||
          !("threadId" in event.payload) ||
          event.payload.threadId !== thread.id ||
          (event.type === "thread.created" &&
            (event.payload.projectId !== bundle.project.projectId || i !== 0)) ||
          ("worktreePath" in event.payload && event.payload.worktreePath != null)
        )
          return yield* Effect.fail(fail("Invalid Project thread history."));
        const next = normalize(event, projectId);
        if (old && i < old.events.length) {
          if (hash(next) !== hash(old.events[i]))
            return yield* Effect.fail(fail("The thread history prefix differs."));
        } else {
          pending.push(next);
        }
      }
    }
    const removeThreads = before.threads
      .filter((thread) => !targetIds.has(thread.id))
      .map((thread) => thread.id);
    if (
      removeThreads.length &&
      (bundle.coordinator !== null || cleanupDigest !== projectMoveDigest(before))
    ) {
      return yield* Effect.fail(
        fail("The destination cleanup manifest differs from the reconciled snapshot."),
      );
    }
    const attachmentRefs = new Set(
      bundle.threads
        .filter((t) => t.events.at(-1)?.type !== "thread.deleted")
        .flatMap((t) => t.events.flatMap((e) => eventAttachments(e).map((f) => `${t.id}/${f.id}`))),
    );
    if (attachmentRefs.size !== bundle.attachments.length)
      return yield* Effect.fail(fail("Attachment inventory mismatch."));
    for (const { threadId, file, bytes, sha256 } of bundle.attachments) {
      const data = Buffer.from(bytes, "base64");
      if (
        !attachmentRefs.delete(`${threadId}/${file.id}`) ||
        sha256Hex(data) !== sha256 ||
        data.length !== file.sizeBytes
      )
        return yield* Effect.fail(fail("Attachment verification failed."));
      yield* io(async () => {
        const target = attachmentPath(config.attachmentsDir, threadId, file);
        retainedAttachments.add(NodePath.basename(target));
        await stageAttachment(stagingDirectory, target, data);
      });
    }
    const receiptIds = new Set(bundle.receipts.map((r) => r.commandId));
    if (receiptIds.size !== bundle.receipts.length)
      return yield* Effect.fail(fail("An execution receipt appears twice."));
    for (const r of bundle.receipts) {
      const namespace = bundle.project.assistant?.scheduleProjectId ?? bundle.project.projectId;
      const valid =
        r.aggregateKind === "thread"
          ? targetIds.has(ThreadId.make(r.aggregateId))
          : r.aggregateId === bundle.project.projectId &&
            ["cp-schedule-run:", "cp-status:"].some((p) =>
              r.commandId.startsWith(p + namespace + ":"),
            );
      if (!valid)
        return yield* Effect.fail(fail("An execution receipt belongs to another Project."));
    }
    const prefix = cleanupDigest ? "cp-project-cleanup" : "cp-project-restore";
    const key = `${prefix}:${moveId}:${projectMoveDigest(bundle)}`;
    yield* withProjectMovePermit(
      id,
      moveId,
      engine.dispatch({
        type: "project.coordinator.restore",
        commandId: CommandId.make(key),
        projectId,
        removeThreads,
        events: pending.map((e) => encodeHistoricalEvent(e)),
        meta: { ...bundle.project, projectId },
      }),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const threadId of removeThreads) {
          yield* sql`DELETE FROM project_move_provider_restarts WHERE thread_id=${threadId}`;
        }
        for (const thread of bundle.threads) {
          // Native session cursors and provider state belong to the machine. A move
          // back to this machine must not reconnect its earlier, now stale conversation.
          yield* sql`UPDATE provider_session_runtime SET status='stopped', resume_cursor_json=NULL,
            runtime_payload_json=CASE WHEN json_type(runtime_payload_json,'$.importedTranscripts')='array'
              THEN json_object('importedTranscripts',json_extract(runtime_payload_json,'$.importedTranscripts'))
              ELSE NULL END WHERE thread_id=${thread.id}`;
          if (thread.events.at(-1)?.type !== "thread.deleted") {
            yield* sql`INSERT INTO project_move_provider_restarts(thread_id,move_id)
              VALUES (${thread.id},${moveId}) ON CONFLICT(thread_id) DO UPDATE SET move_id=excluded.move_id`;
          }
        }
        for (const r of bundle.receipts) {
          const aggregate = r.aggregateKind === "project" ? id : r.aggregateId;
          yield* sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error)
          VALUES(${r.commandId},${r.aggregateKind},${aggregate},${r.acceptedAt},${yield* engine.latestSequence},${r.status},${r.error})
          ON CONFLICT(command_id) DO NOTHING`;
          const [row] =
            yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id=${r.commandId}
          AND aggregate_kind=${r.aggregateKind} AND aggregate_id=${aggregate} AND accepted_at=${r.acceptedAt}
          AND status=${r.status} AND error IS ${r.error}`;
          if (!row)
            return yield* Effect.fail(fail("An execution receipt collides on this machine."));
        }
        if (cleanupDigest)
          for (const r of before.receipts) {
            if (!receiptIds.has(r.commandId))
              yield* sql`DELETE FROM orchestration_command_receipts
          WHERE command_id=${r.commandId} AND aggregate_kind=${r.aggregateKind} AND aggregate_id=${r.aggregateId}`;
          }
      }),
    );
    yield* io(async () => {
      for (const key of new Set([...Object.keys(before.roles), ...Object.keys(bundle.roles)])) {
        const target = rolePath(project.workspaceRoot, key);
        if (key.includes("/")) {
          const dir = NodePath.dirname(target);
          await NodeFSP.mkdir(dir, { recursive: true });
          if (!(await NodeFSP.lstat(dir)).isDirectory())
            throw fail("The Project role directory is not a directory.");
        }
        await replaceFile(
          target,
          bundle.roles[key] === undefined ? null : Buffer.from(bundle.roles[key], "base64"),
        );
      }
      await replaceFile(
        NodePath.join(project.workspaceRoot, "MEMORY.md"),
        bundle.memory === null ? null : Buffer.from(bundle.memory, "base64"),
      );
    });
    const actual = yield* capture(id);
    if (projectMoveDigest(actual) !== projectMoveDigest(bundle))
      return yield* Effect.fail(fail("The restored Project failed readback verification."));
    if (!retainAttachmentProof) {
      yield* io(() =>
        finishAttachments(stagingDirectory, retainedAttachments, cleanupDigest !== undefined),
      );
    }
  });
  return { capture, install, digest: projectMoveDigest };
});
