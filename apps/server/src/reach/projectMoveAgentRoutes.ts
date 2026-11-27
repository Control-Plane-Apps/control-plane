import { ThreadId, type RemoteAgentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ReachShape } from "./Reach.ts";
import { ReachRequest, opFailed, type ReachRequest as Request } from "./reachProtocol.ts";
import { projectMoveFenceOwner } from "./projectMoveFence.ts";

export const WorkerRoute = Schema.Struct({
  threadId: Schema.String,
  machineId: Schema.String,
  projectId: Schema.String,
  origin: Schema.Struct({ machineId: Schema.String, projectId: Schema.String }),
});
type WorkerRoute = typeof WorkerRoute.Type;
export function openWorkerRoutes(
  records: readonly RemoteAgentRecord[],
  machineId: string,
  projectId: string,
) {
  return records
    .filter((record) => record.homeProjectId === projectId && record.state === "open")
    .map((record) => ({
      threadId: record.threadId,
      machineId: record.machineId,
      projectId: record.peerProjectId,
      origin: record.placementOrigin ?? { machineId, projectId },
    }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
}

const verified = Schema.Struct({ verified: Schema.Literal(true) });
const decodeWorker = Schema.decodeUnknownEffect(WorkerRoute);

/** Probe the actual worker's execution Project and immutable first prompt on its pinned link. */
export const verifyWorkers = (reach: ReachShape, routes: readonly WorkerRoute[]) =>
  Effect.forEach(
    routes,
    (route) =>
      Effect.gen(function* () {
        const worker = (yield* reach.machines).find((machine) => machine.id === route.machineId);
        if (!worker || worker.id === (yield* reach.self).environmentId)
          return yield* opFailed(
            "The coordinator needs a direct link to the agent's original worker machine.",
          );
        yield* reach.call(
          worker,
          "agent.routeCheck",
          route,
          { threadId: "", threadTitle: "" },
          verified,
          { fresh: true },
        );
      }),
    { discard: true },
  );

export const checkWorkerRoute = (
  reach: ReachShape,
  snapshots: ProjectionSnapshotQuery["Service"],
  request: Request,
) =>
  Effect.gen(function* () {
    const input = yield* decodeWorker(request.input);
    if (
      input.machineId !== (yield* reach.self).environmentId ||
      !(yield* reach.machines).some((machine) => machine.id === input.origin.machineId)
    )
      return yield* opFailed("The worker's return link cannot be verified.");
    const thread = Option.getOrNull(
      yield* snapshots.getThreadDetailById(ThreadId.make(input.threadId)),
    );
    const shell = Option.getOrNull(
      yield* snapshots.getThreadShellById(ThreadId.make(input.threadId)),
    );
    const first = thread?.messages.find((message) => message.role === "user")?.source;
    if (
      !thread ||
      thread.projectId !== input.projectId ||
      thread.archivedAt ||
      thread.settledAt ||
      !shell ||
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      thread.latestTurn?.state === "running" ||
      thread.session?.activeTurnId ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      first?.kind !== "agent" ||
      first.placementHome?.machineId !== input.origin.machineId ||
      first.placementHome.projectId !== input.origin.projectId ||
      (yield* snapshots.getHandoffActivities(thread.id)).some(
        (activity) => activity.kind === "agent.handoff.held",
      )
    )
      return yield* opFailed(
        "The linked agent's original Project, return route or idle state could not be verified.",
      );
    return { verified: true };
  });

/** Save only the identity needed to authenticate a callback that still arrives at a former home.
 * These rows have no effect until that home has a matching receipt relinquishing execution. */
export const rememberWorkerRoutes = (
  sql: SqlClient.SqlClient,
  projectId: string,
  moveId: string,
  self: string,
  agents: readonly RemoteAgentRecord[],
) =>
  Effect.forEach(
    agents.filter(
      (agent) =>
        agent.state === "open" &&
        agent.placementOrigin?.machineId === self &&
        agent.placementOrigin.projectId === projectId,
    ),
    (agent) =>
      sql`INSERT INTO project_move_agent_relays (home_project_id,move_id,worker_id,worker_project_id,thread_id)
      VALUES (${projectId},${moveId},${agent.machineId},${agent.peerProjectId},${agent.threadId}) ON CONFLICT DO NOTHING`,
    { discard: true },
  );

/** A worker created on a former target still sends callbacks here after rollback.
 * Its original thread ID cannot be reassigned to another local placement. */
export const hasReturnedWorkerRoute = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`SELECT 1 FROM project_move_agent_relays a JOIN project_move_receipts r
      ON r.project_id=a.home_project_id AND r.move_id=a.move_id
      WHERE a.thread_id=${threadId} AND r.role='target' AND r.phase='rolled-back' LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

const PeerScope = Schema.Struct({ threadId: Schema.String, projectId: Schema.String });
const decodeScope = Schema.decodeUnknownEffect(PeerScope);
const Forward = Schema.Struct({
  original: ReachRequest,
  home: Schema.String,
  target: Schema.String,
  moveId: Schema.String,
});
const decodeForward = Schema.decodeUnknownEffect(Forward);
type RelayRow = {
  home_project_id: string;
  peer_id: string;
  peer_project_id: string;
  role: string;
  phase: string;
  move_id: string;
};
export const routePlacedPeer = <A, E>(
  sql: SqlClient.SqlClient,
  reach: ReachShape,
  local: (
    request: Request,
    relay?: { target: string; origin: string; project: string },
  ) => Effect.Effect<A, E>,
  request: Request,
  localAssociations: Effect.Effect<readonly RemoteAgentRecord[], Error> | undefined,
) =>
  Effect.gen(function* () {
    if (request.op === "agent.peerRelay") {
      const forwarded = yield* decodeForward(request.input);
      if (forwarded.original.op !== "agent.peers")
        return yield* opFailed("Invalid forwarded placement operation.");
      const origin = yield* decodeScope(forwarded.original.input);
      if (
        origin.threadId !== forwarded.original.caller.threadId ||
        request.caller.threadId !== origin.threadId
      )
        return yield* opFailed("The forwarded worker scope differs.");
      const [receipt] =
        yield* sql<RelayRow>`SELECT * FROM project_move_receipts WHERE project_id=${forwarded.target}
        AND rowid=(SELECT MAX(rowid) FROM project_move_receipts WHERE project_id=${forwarded.target})
        AND move_id=${forwarded.moveId} AND peer_project_id=${forwarded.home} AND peer_id=${request.caller.environmentId}`;
      if (
        !receipt ||
        !(
          (receipt.role === "source" && receipt.phase === "rolled-back") ||
          (receipt.role === "target" && receipt.phase === "active")
        ) ||
        (yield* projectMoveFenceOwner(sql, forwarded.target)) !== null
      )
        return yield* opFailed("The coordinator has not taken ownership of this worker.");
      // The normal handler also matches machine, execution Project, live record, and target peer.
      return yield* local(forwarded.original, {
        target: forwarded.target,
        origin: request.caller.environmentId,
        project: forwarded.home,
      });
    }
    const scope = yield* decodeScope(request.input);
    if (scope.threadId !== request.caller.threadId)
      return yield* opFailed("The worker's scope differs.");
    const rows =
      yield* sql<RelayRow>`SELECT a.home_project_id,r.peer_id,r.peer_project_id,r.role,r.phase,r.move_id
      FROM project_move_agent_relays a JOIN project_move_receipts r ON r.project_id=a.home_project_id AND r.move_id=a.move_id
      WHERE a.worker_id=${request.caller.environmentId} AND a.worker_project_id=${scope.projectId} AND a.thread_id=${scope.threadId}
      AND ((r.role='source' AND r.phase='active' AND r.rowid=(
          SELECT MAX(current.rowid) FROM project_move_receipts current WHERE current.project_id=r.project_id))
        OR (r.role='target' AND r.phase='rolled-back'))
      ORDER BY r.rowid DESC LIMIT 2`;
    if (!rows.length) return yield* local(request);
    if (rows.length !== 1)
      return yield* opFailed("The worker's former home has ambiguous placement receipts.");
    const row = rows[0]!;
    // A terminal return route belongs to this exact worker. A later occupant of
    // the checkout has its own coordinator and cannot inherit its authority.
    if (
      row.role === "target" &&
      (!localAssociations ||
        (yield* localAssociations).some((record) => record.threadId === scope.threadId))
    )
      return yield* opFailed("A local association conflicts with the worker's return route.");
    if (
      row.role === "source" &&
      (yield* projectMoveFenceOwner(sql, row.home_project_id)) !== row.move_id
    )
      return yield* opFailed("The former coordinator fence cannot be verified.");
    const peer = (yield* reach.machines).find((machine) => machine.id === row.peer_id);
    if (!peer) return yield* opFailed("The worker's current coordinator is unreachable.");
    return yield* reach.call(
      peer,
      "agent.peerRelay",
      {
        original: request,
        home: row.home_project_id,
        target: row.peer_project_id,
        moveId: row.move_id,
      },
      { threadId: scope.threadId, threadTitle: "" },
      Schema.Unknown,
      { fresh: true },
    );
  });
