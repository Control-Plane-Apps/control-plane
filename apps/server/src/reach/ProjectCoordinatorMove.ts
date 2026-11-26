import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  AgentMachinesError,
  ProjectId,
  ProjectMoveBundle,
  ThreadId,
  type AgentMachinesInput,
  type AgentMachinesResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AgentMachines } from "../agentMachines/AgentMachines.ts";
import { ServerConfig } from "../config.ts";
import { matchPeerProject } from "../agentMachines/projectMatch.ts";
import { makeProjectReadiness, missingReadiness } from "../agentMachines/projectReadiness.ts";
import { workspaceFingerprint } from "../agentMachines/workspaceFingerprint.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { HostTimeZoneSource } from "../schedules/hostZone.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { Reach } from "./Reach.ts";
import { makeProjectMoveData } from "./projectMoveData.ts";
import {
  acquireProjectMoveFence,
  releaseProjectMoveFence,
  projectMoveFenceOwner,
} from "./projectMoveFence.ts";
import { MoveRequirements, ProjectMoveReply, type ProjectMoveStep } from "./projectMoveProtocol.ts";
import { verifyProjectIntegrations } from "./projectMoveReadiness.ts";

type Input = Extract<AgentMachinesInput, { action: "coordinatorMove" }>;
type Status = NonNullable<AgentMachinesResult["coordinatorMove"]>;
type Requirements = typeof MoveRequirements.Type;
type Receipt = {
  readonly project_id: string;
  readonly move_id: string;
  readonly peer_id: string;
  readonly peer_project_id: string;
  readonly role: "source" | "target";
  readonly phase: string;
  readonly digest: string | null;
  readonly backup: string | null;
  readonly target_digest: string | null;
  readonly requirements: string | null;
};
interface Service {
  manage(input: Input): Effect.Effect<AgentMachinesResult, AgentMachinesError>;
  step(peer: string, input: ProjectMoveStep): Effect.Effect<ProjectMoveReply, AgentMachinesError>;
}
const refusal = (detail: string) => new AgentMachinesError({ detail });
export class ProjectCoordinatorMove extends Context.Reference<Service>(
  "t3/ProjectCoordinatorMove",
  {
    defaultValue: () => ({
      manage: () => Effect.fail(refusal("Coordinator moves are unavailable.")),
      step: () => Effect.fail(refusal("Coordinator moves are unavailable.")),
    }),
  },
) {}
const requirementsJson = Schema.fromJsonString(MoveRequirements);
const encodeRequirements = Schema.encodeEffect(requirementsJson);
const decodeRequirements = Schema.decodeUnknownEffect(requirementsJson);
const encodeBackup = Schema.encodeEffect(Schema.fromJsonString(ProjectMoveBundle));
const encodeApproval = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.String,
      MoveRequirements,
      Schema.String,
      Schema.String,
    ]),
  ),
);
const decodeBackup = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMoveBundle));
const safeError = (error: { message: string }) => refusal(error.message);
export const makeProjectCoordinatorMove = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  // An independent SQLite connection serializes move operations across server processes.
  // Process exit releases its file lock, including after an unacknowledged peer call.
  // Keeping it off the orchestration database lets turns and readbacks use their own transactions.
  const serialize = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const db = new DatabaseSync(config.stateDir + "/project-coordinator-move-lock.sqlite");
          try {
            db.exec("PRAGMA busy_timeout=0");
            db.exec("BEGIN IMMEDIATE");
            return db;
          } catch (cause) {
            db.close();
            throw cause;
          }
        },
        catch: () =>
          refusal("Could not acquire the coordinator move lock. Refresh the receipt and retry."),
      }),
      () => work,
      (db) => Effect.sync(() => db.close()),
    );
  const cryptoService = yield* Crypto.Crypto;
  const data = yield* makeProjectMoveData;
  const snapshots = yield* ProjectionSnapshotQuery;
  const machines = yield* AgentMachines;
  const reach = yield* Reach;
  const settings = yield* ServerSettingsService;
  const hostZone = yield* HostTimeZoneSource;
  const providers = yield* ProviderRegistry;
  const readiness = yield* makeProjectReadiness;
  const latest = (project: string) =>
    sql<Receipt>`SELECT * FROM project_move_receipts
    WHERE project_id = ${project} ORDER BY rowid DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]));
  const insert = (r: Receipt) => sql`INSERT INTO project_move_receipts
    (project_id,move_id,peer_id,peer_project_id,role,phase,digest,backup,target_digest,requirements) VALUES
    (${r.project_id},${r.move_id},${r.peer_id},${r.peer_project_id},${r.role},${r.phase},${r.digest},${r.backup},${r.target_digest},${r.requirements})`;
  const phase = (r: Receipt, next: string, digest = r.digest) => sql`UPDATE project_move_receipts
    SET phase=${next}, digest=${digest} WHERE project_id=${r.project_id} AND move_id=${r.move_id}`;
  const project = (id: string) =>
    snapshots
      .getProjectShellById(ProjectId.make(id))
      .pipe(
        Effect.flatMap((p) =>
          Option.isSome(p) &&
          p.value.assistant?.scope !== "global" &&
          !p.value.assistant?.archivedAt
            ? Effect.succeed(p.value)
            : Effect.fail(refusal("Select an active Project.")),
        ),
      );
  const checkout = (id: string) =>
    Effect.gen(function* () {
      const p = yield* project(id);
      if (!p.repositoryIdentity)
        return yield* refusal("Register the Project repository on both machines.");
      const identity = p.repositoryIdentity;
      const fp = yield* Effect.tryPromise({
        try: () => workspaceFingerprint(p.workspaceRoot, identity),
        catch: () => refusal("Could not verify the Project checkout."),
      });
      return {
        repository: identity.canonicalKey,
        branch: fp.branch,
        commit: fp.commit,
        digest: fp.digest,
      };
    });
  const requirements = (id: string) =>
    Effect.gen(function* () {
      const p = yield* project(id);
      if (!p.assistant) return yield* refusal("Select a Project with a coordinator.");
      const thread = yield* snapshots.getThreadShellById(
        ThreadId.make(p.assistant.coordinatorThreadId),
      );
      if (Option.isNone(thread)) return yield* refusal("The coordinator thread is unavailable.");
      const cfg = yield* settings.getSettings;
      return {
        checkout: yield* checkout(id),
        scheduleZone: p.assistant.schedules?.length ? hostZone().zone : null,
        model: thread.value.modelSelection,
        integrations: cfg.agentPlacement.projectRequirements?.[id] ?? [],
      };
    });
  const checkTarget = (id: string, req: Requirements) =>
    Effect.gen(function* () {
      if (req.scheduleZone && hostZone().zone !== req.scheduleZone)
        return yield* refusal("The schedule time zones differ.");
      const local = yield* checkout(id);
      if (
        local.repository !== req.checkout.repository ||
        local.branch !== req.checkout.branch ||
        local.commit !== req.checkout.commit ||
        local.digest !== req.checkout.digest
      )
        return yield* refusal("The repository, branch, commit or workspace contents differ.");
      const p = yield* project(id);
      const provider = yield* (
        providers.probeMoveProvider?.(req.model.instanceId) ?? Effect.succeed(undefined)
      );
      if (!provider)
        return yield* refusal("Could not verify the destination provider's current access.");
      if (!provider.models.some((model) => model.slug === req.model.model && !model.isCustom))
        return yield* refusal("The destination provider does not offer the coordinator model.");
      const evidence = yield* readiness(p, provider);
      const cfg = yield* settings.getSettings;
      const needed = [
        ...new Set([...req.integrations, ...(cfg.agentPlacement.projectRequirements?.[id] ?? [])]),
      ];
      const missing = missingReadiness(evidence, needed);
      if (missing) return yield* refusal(missing);
      yield* verifyProjectIntegrations(
        needed,
        p.workspaceRoot,
        req.checkout.repository,
        providers.verifyWorkspaceMcp?.(req.model.instanceId, p.workspaceRoot),
      );
    });

  const step: Service["step"] = (peer, input) =>
    serialize(
      Effect.gen(function* () {
        const { projectId, moveId, peerProjectId } = input;
        let r = yield* latest(projectId);
        const history =
          yield* sql<Receipt>`SELECT * FROM project_move_receipts WHERE project_id=${projectId} AND move_id=${moveId}`;
        if (history[0] && history[0].move_id !== r?.move_id)
          return yield* refusal("This move was superseded.");
        if (r && r.move_id !== moveId && r.phase === "rolled-back") r = undefined;
        if (
          r &&
          (r.role !== "target" ||
            r.move_id !== moveId ||
            r.peer_id !== peer ||
            r.peer_project_id !== peerProjectId)
        )
          return yield* refusal("Another move owns this Project.");
        const newReceipt: Receipt = {
          project_id: projectId,
          move_id: moveId,
          peer_id: peer,
          peer_project_id: peerProjectId,
          role: "target",
          phase: "staging",
          digest: null,
          backup: null,
          target_digest: null,
          requirements: null,
        };
        if (input.action === "preflight" || input.action === "stage") {
          if (
            input.action === "stage" &&
            (!input.bundle.coordinator || input.bundle.project.projectId !== peerProjectId)
          )
            return yield* refusal("The snapshot belongs to another Project.");
          if (r?.phase === "active" && input.action === "stage" && r.digest === input.digest)
            return { phase: "active", digest: input.digest };
          if (r && !["preparing", "staging"].includes(r.phase))
            return yield* refusal("This move is closed.");
          yield* checkTarget(projectId, input.requirements);
          if (!r) {
            const backup = yield* data.capture(projectId);
            if (backup.coordinator || backup.threads.length)
              return yield* refusal("Choose an empty destination Project.");
            if (input.action === "preflight")
              return { phase: "ready", digest: data.digest(backup) };
            if (input.targetDigest !== data.digest(backup))
              return yield* refusal(
                "Destination changed after review. Roll back and review a new move.",
              );
            r = {
              ...newReceipt,
              requirements: yield* encodeRequirements(input.requirements),
              phase: "preparing",
              digest: input.digest,
              backup: yield* encodeBackup(backup),
            };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* acquireProjectMoveFence(projectId, moveId);
                yield* insert(r!);
              }),
            );
          }
          if (input.action === "preflight") return { phase: "ready" };
          if (r.phase === "preparing") {
            if (
              !r.backup ||
              data.digest(yield* data.capture(projectId)) !==
                data.digest(yield* decodeBackup(r.backup))
            )
              return yield* refusal("Destination changed during preflight.");
            yield* phase(r, "staging");
          }
          if (input.digest !== r.digest || input.digest !== data.digest(input.bundle))
            return yield* refusal("The transfer checksum changed.");
          yield* data.install(projectId, moveId, input.bundle);
          if (data.digest(yield* data.capture(projectId)) !== input.digest)
            return yield* refusal("Destination verification failed.");
          return { phase: "staging", digest: input.digest };
        }
        if (!r) {
          if (input.action !== "reverse") return yield* refusal("Unknown coordinator move.");
          yield* insert({ ...newReceipt, phase: "rolled-back" });
          return { phase: "rolled-back" };
        }
        if (
          !["active", "rolled-back"].includes(r.phase) &&
          (yield* projectMoveFenceOwner(sql, projectId)) !== moveId
        )
          return yield* refusal("The destination fence cannot be confirmed.");
        if (input.action === "activate") {
          if (r.digest !== input.digest || !["staging", "active"].includes(r.phase))
            return yield* refusal("The move is no longer available for activation.");
          if (r.phase === "staging") {
            if (!r.requirements) return yield* refusal("Missing destination readiness record.");
            yield* checkTarget(projectId, yield* decodeRequirements(r.requirements));
            if (data.digest(yield* data.capture(projectId)) !== input.digest)
              return yield* refusal("Destination verification failed.");
            yield* sql.withTransaction(
              phase(r, "active").pipe(Effect.andThen(releaseProjectMoveFence(projectId, moveId))),
            );
          }
          return { phase: "active", digest: input.digest };
        }
        if (r.phase === "rolled-back") return { phase: "rolled-back" };
        if (input.action === "reverse") {
          if (r.phase === "active") {
            yield* sql.withTransaction(
              acquireProjectMoveFence(projectId, moveId).pipe(
                Effect.andThen(phase(r, "returning")),
              ),
            );
            r = { ...r, phase: "returning" };
          }
          if (r.phase === "returning") {
            const bundle = yield* data.capture(projectId);
            const digest = data.digest(bundle);
            yield* phase(r, "returning", digest);
            return { phase: "returning", bundle, digest };
          }
          if (r.phase === "preparing") {
            yield* sql.withTransaction(
              phase(r, "rolled-back").pipe(
                Effect.andThen(releaseProjectMoveFence(projectId, moveId)),
              ),
            );
            return { phase: "rolled-back" };
          }
          if (r.phase === "staging") yield* phase(r, "aborting");
          return { phase: "aborting" };
        }
        if (!["aborting", "returning", "restoring"].includes(r.phase) || !r.backup)
          return yield* refusal("Fence the destination before restoring it.");
        if (r.phase === "returning" && input.returnedDigest !== r.digest)
          return yield* refusal("The source has not verified this rollback checksum.");
        const backup = yield* decodeBackup(r.backup);
        const cleanupDigest =
          r.phase === "restoring" || r.phase === "returning"
            ? r.digest
            : data.digest(yield* data.capture(projectId));
        if (!cleanupDigest) return yield* refusal("Missing rollback checksum.");
        yield* phase(r, "restoring", cleanupDigest);
        yield* data.install(projectId, moveId, backup, cleanupDigest);
        if (data.digest(yield* data.capture(projectId)) !== data.digest(backup))
          return yield* refusal("Destination recovery copy differs.");
        yield* sql.withTransaction(
          phase(r, "rolled-back").pipe(Effect.andThen(releaseProjectMoveFence(projectId, moveId))),
        );
        return { phase: "rolled-back" };
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(safeError)),
    );

  const status = (r?: Receipt): Status => ({
    phase: r?.phase === "finishing-rollback" ? "rolling-back" : (r?.phase ?? "idle"),
    ownerId: r?.role === "source" && r.phase === "active" ? r.peer_id : "local",
    ready: false,
    detail:
      r?.phase === "active"
        ? "Coordinator move verified."
        : r?.phase === "rolled-back"
          ? "Original coordinator restored."
          : r
            ? "A coordinator move is in progress."
            : "Coordinator runs on this machine.",
    ...(r ? { moveId: r.move_id, destinationId: r.peer_id, incoming: r.role === "target" } : {}),
  });
  const manage: Service["manage"] = (input) =>
    input.operation === "status"
      ? latest(input.projectId).pipe(
          Effect.map((r) => ({ machines: [], coordinatorMove: status(r) })),
          Effect.mapError(safeError),
        )
      : serialize(
          Effect.gen(function* () {
            const id = input.projectId;
            let r = yield* latest(id);
            const result = (s: Status) => ({ machines: [], coordinatorMove: s });
            if (
              r?.phase === "rolled-back" &&
              (input.operation === "move" || input.operation === "preflight") &&
              r.move_id !== input.moveId
            )
              r = undefined;
            if (
              r &&
              (r.role !== "source" ||
                (input.moveId && r.move_id !== input.moveId) ||
                (input.destinationId && input.destinationId !== r.peer_id))
            )
              return yield* refusal("This request does not match the current move.");
            if (
              r &&
              (input.operation === "rollback" || input.operation === "retry") &&
              input.moveId !== r.move_id
            )
              return yield* refusal("Refresh the move receipt before continuing.");
            const destination = r?.peer_id ?? input.destinationId;
            const peer = (yield* reach.machines).find((p) => p.id === destination);
            if (!peer || peer.id === (yield* reach.self).environmentId)
              return yield* refusal("Choose a linked destination.");
            const call = (body: ProjectMoveStep) =>
              reach.call(
                peer,
                "project.moveStep",
                body,
                { threadId: "", threadTitle: "" },
                ProjectMoveReply,
                { fresh: true, timeout: Duration.minutes(2) },
              );
            if (!r) {
              if (input.operation !== "move" && input.operation !== "preflight")
                return yield* refusal("There is no move to recover.");
              const p = yield* project(id);
              const linked = (yield* settings.getSettings).agentPlacement.machines[peer.id];
              if (!linked?.enabled) return yield* refusal("Enable the linked destination first.");
              const match = matchPeerProject(
                p,
                (yield* machines.shell(peer.id, { fresh: true })).projects,
                true,
              );
              if (match.kind !== "matched")
                return yield* refusal("Register an unambiguous matching destination Project.");
              const req = yield* requirements(id);
              const backup = yield* data.capture(id);
              const moveId = input.moveId ?? (yield* cryptoService.randomUUIDv4);
              const previous =
                yield* sql`SELECT move_id FROM project_move_receipts WHERE project_id=${id} AND move_id=${moveId}`;
              if (previous.length) return yield* refusal("Start a new move with a fresh move ID.");
              const preflight = yield* call({
                action: "preflight",
                projectId: match.projectId,
                peerProjectId: id,
                moveId,
                requirements: req,
              });
              if (preflight.phase !== "ready" || !preflight.digest)
                return yield* refusal("Destination readiness was not verified.");
              const targetDigest = preflight.digest;
              const approvalDigest = createHash("sha256")
                .update(
                  yield* encodeApproval([
                    id,
                    peer.id,
                    match.projectId,
                    req,
                    data.digest(backup),
                    targetDigest,
                  ]),
                )
                .digest("hex");
              if (input.operation === "preflight")
                return result({
                  ...status(),
                  ready: true,
                  approvalDigest,
                  destinationId: peer.id,
                  detail: `Verified ${req.checkout.branch} at ${req.checkout.commit.slice(0, 12)} and provider access for ${req.model.model}.${req.integrations.length ? " Checked " + req.integrations.join(", ") + "." : ""} The move includes ${backup.threads.length} threads, ${backup.attachments.length} attachments and ${backup.project.assistant?.schedules?.length ?? 0} schedules.`,
                });
              if (input.approvalDigest !== approvalDigest)
                return yield* refusal(
                  "The move proposal changed. Check the destination and approve it again.",
                );
              r = yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* acquireProjectMoveFence(id, moveId);
                  const record: Receipt = {
                    project_id: id,
                    move_id: moveId,
                    peer_id: peer.id,
                    peer_project_id: match.projectId,
                    role: "source",
                    phase: "fenced",
                    digest: data.digest(backup),
                    backup: yield* encodeBackup(backup),
                    target_digest: targetDigest,
                    requirements: yield* encodeRequirements(req),
                  };
                  yield* insert(record);
                  return record;
                }),
              );
            }
            if (r.phase !== "rolled-back" && (yield* projectMoveFenceOwner(sql, id)) !== r.move_id)
              return yield* refusal("The source fence cannot be confirmed.");
            const binding = { projectId: r.peer_project_id, peerProjectId: id, moveId: r.move_id };
            if (
              input.operation === "rollback" ||
              r.phase === "rolling-back" ||
              r.phase === "finishing-rollback"
            ) {
              if (r.phase === "rolled-back") return result(status(r));
              if (r.phase !== "finishing-rollback") {
                if (
                  r.phase !== "fenced" &&
                  r.phase !== "rolling-back" &&
                  data.digest(yield* data.capture(id)) !== r.digest
                )
                  return yield* refusal("The fenced source no longer matches its recovery copy.");
                yield* phase(r, "rolling-back");
                const back = yield* call({ ...binding, action: "reverse" });
                if (back.phase === "returning") {
                  if (
                    !back.bundle ||
                    back.bundle.project.projectId !== r.peer_project_id ||
                    !back.bundle.coordinator ||
                    back.digest !== data.digest(back.bundle)
                  )
                    return yield* refusal("The rollback snapshot checksum differs.");
                  yield* data.install(id, r.move_id, back.bundle);
                  if (data.digest(yield* data.capture(id)) !== back.digest)
                    return yield* refusal("Source recovery verification failed.");
                } else if (!["aborting", "rolled-back"].includes(back.phase))
                  return yield* refusal("The destination fence is unconfirmed.");
                const returnedDigest = back.phase === "returning" ? (back.digest ?? null) : null;
                yield* phase(r, "finishing-rollback", returnedDigest);
                r = { ...r, phase: "finishing-rollback", digest: returnedDigest };
              }
              if (
                (yield* call({
                  ...binding,
                  action: "finishRollback",
                  ...(r.digest ? { returnedDigest: r.digest } : {}),
                })).phase !== "rolled-back"
              )
                return yield* refusal("Destination recovery is pending.");
              yield* sql.withTransaction(
                phase(r, "rolled-back").pipe(
                  Effect.andThen(releaseProjectMoveFence(id, r.move_id)),
                ),
              );
              return result(status({ ...r, phase: "rolled-back" }));
            }
            if (r.phase === "active" || r.phase === "rolled-back") return result(status(r));
            if (!["retry", "move"].includes(input.operation) || !r.digest || !r.backup)
              return yield* refusal("Resume the current coordinator move.");
            const bundle = yield* decodeBackup(r.backup);
            if (
              !r.requirements ||
              (yield* encodeRequirements(yield* requirements(id))) !== r.requirements
            )
              return yield* refusal(
                "The source checkout, provider or required integrations changed after approval.",
              );
            if (r.phase === "fenced") {
              if (!r.target_digest || !r.requirements)
                return yield* refusal("Missing destination preflight checksum.");
              if (data.digest(yield* data.capture(id)) !== r.digest)
                return yield* refusal("Source changed after fencing.");
              const staged = yield* call({
                ...binding,
                action: "stage",
                targetDigest: r.target_digest,
                requirements: yield* decodeRequirements(r.requirements),
                bundle,
                digest: r.digest,
              });
              if (staged.phase !== "staging" || staged.digest !== r.digest)
                return yield* refusal("Destination staging is unverified.");
              yield* phase(r, "staging");
            }
            if (data.digest(yield* data.capture(id)) !== r.digest)
              return yield* refusal("Source changed before ownership was confirmed.");
            const activated = yield* call({ ...binding, action: "activate", digest: r.digest });
            if (activated.phase !== "active" || activated.digest !== r.digest)
              return yield* refusal("Destination activation is unconfirmed.");
            yield* phase(r, "active");
            return result(status({ ...r, phase: "active" }));
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(safeError)),
        );
  return { manage, step } satisfies Service;
});
export const ProjectCoordinatorMoveLive = Layer.effect(
  ProjectCoordinatorMove,
  makeProjectCoordinatorMove,
).pipe(Layer.provide(ProjectionProjectRepositoryLive));
