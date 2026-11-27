// @effect-diagnostics nodeBuiltinImport:off - ephemeral loopback HTTP servers.
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "../mcp/toolkits/threads/handlers.ts";
import { ThreadsToolkit, AgentMessageResult } from "../mcp/toolkits/threads/tools.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpRouter, HttpServer, HttpServerResponse, FetchHttpClient } from "effect/unstable/http";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { AgentMachinesLive, agentMachineSecretName } from "../agentMachines/AgentMachines.ts";
import { linkTokenSubject } from "../agentMachines/linkToken.ts";
import { AGENT_MACHINE_PROTOCOL_VERSION } from "../agentMachines/AgentMachineClient.ts";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { reachRouteLayer } from "./route.ts";
import { RemoteAgentsLive } from "../agentMachines/RemoteAgents.ts";
import { RemoteAgentStore, RemoteAgentStoreLive } from "../agentMachines/RemoteAgentStore.ts";
import { makeRecord } from "../agentMachines/testFixtures.ts";
import { ServerConfig } from "../config.ts";
import { agentDeliveryStartId } from "../orchestration/agentProtocol.ts";
import { AgentLineage } from "../orchestration/agentLineage.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import {
  makeScheduleEngineLayer,
  makeScheduleFixture,
} from "../schedules/schedules.testFixtures.ts";
import { Reach, ReachLive } from "./Reach.ts";

import { ProjectCoordinatorMove, ProjectCoordinatorMoveLive } from "./ProjectCoordinatorMove.ts";

const decodeProvider = Schema.decodeEffect(ServerProvider);
const decodePeerMessage = Schema.decodeUnknownEffect(AgentMessageResult);

it.live(
  "moves a linked worker association and routes scoped, deduplicated replies through its former home",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const origin = ProjectId.make("old-project"),
          target = ProjectId.make("new-project"),
          workerProject = ProjectId.make("worker-project");
        const coordinator = ThreadId.make("coordinator"),
          worker = ThreadId.make("worker-thread");
        const move = "transfer";
        const machines = ["origin", "target", "worker"].map((id) => ({ id, label: id }));
        const provider = yield* decodeProvider({
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          version: "1",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00Z",
          models: [{ slug: "gpt-5-codex", name: "Synthetic", isCustom: false, capabilities: null }],
        });
        let originRoot: string | undefined;
        const git = (cwd: string, ...args: string[]) =>
          Effect.try(() => NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" }));
        const addresses = new Map<string, string>();
        const setup = (machine: string, id: ProjectId) =>
          Effect.gen(function* () {
            const descriptor = {
              environmentId: EnvironmentId.make(machine),
              label: machine,
              platform: { os: "linux" as const, arch: "x64" as const },
              serverVersion: "0.0.96",
              orchestrationProtocolVersion: AGENT_MACHINE_PROTOCOL_VERSION,
              capabilities: { repositoryIdentity: true },
            };
            const identity = { getEnvironmentId: Effect.succeed(descriptor.environmentId) };
            const settings = Layer.mock(ServerSettingsService)({
              getSettings: Effect.sync(() => ({
                ...DEFAULT_SERVER_SETTINGS,
                agentPlacement: {
                  ...DEFAULT_SERVER_SETTINGS.agentPlacement,
                  machines: Object.fromEntries(
                    machines
                      .filter((m) => m.id !== machine)
                      .map((m) => [
                        m.id,
                        {
                          label: m.label,
                          baseUrl: addresses.get(m.id) ?? "http://127.0.0.1:1",
                          enabled: true,
                          preference: 50,
                        },
                      ]),
                  ),
                },
              })),
            });
            const foundation = Layer.mergeAll(
              ProjectionProjectRepositoryLive,
              ProjectionThreadMessageRepositoryLive,
              RemoteAgentStoreLive,
              AgentLineage.layer,
              Layer.succeed(Environment.ServerEnvironmentIdentity, identity),
              Layer.succeed(Environment.ServerEnvironment, {
                ...identity,
                getDescriptor: Effect.succeed(descriptor),
              }),
              settings,
              makeProviderRegistryLayer([provider]),
              Secrets.layer,
              FetchHttpClient.layer,
            ).pipe(Layer.provideMerge(makeScheduleEngineLayer("move-route-" + machine)));
            const base = ProjectCoordinatorMoveLive.pipe(
              Layer.provideMerge(Layer.merge(RemoteAgentsLive, ReachLive)),
              Layer.provideMerge(AgentMachinesLive),
              Layer.provideMerge(Auth.layer),
              Layer.provideMerge(foundation),
            );
            const server = NodeHttpServer.layer(NodeHttp.createServer, {
              host: "127.0.0.1",
              port: 0,
            });
            const env = yield* Layer.build(Layer.merge(base, server));
            const runtimeLayer = Layer.succeedContext(env);
            const http = Context.get(env, HttpServer.HttpServer);
            if (http.address._tag !== "InetAddressV4")
              throw new Error("Expected a loopback TCP listener.");
            addresses.set(machine, "http://127.0.0.1:" + http.address.port);
            const routes = Layer.mergeAll(
              HttpRouter.add(
                "GET",
                "/api/orchestration/shell",
                Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getShellSnapshot()).pipe(
                  Effect.map(HttpServerResponse.jsonUnsafe),
                  Effect.orDie,
                ),
              ),
              reachRouteLayer,
              HttpRouter.add(
                "GET",
                "/.well-known/t3/environment",
                HttpServerResponse.jsonUnsafe(descriptor),
              ),
            );
            yield* Layer.build(
              HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
                Layer.provide(runtimeLayer),
              ),
            );
            return yield* Effect.provide(
              Effect.gen(function* () {
                const fixture = yield* makeScheduleFixture,
                  config = yield* ServerConfig,
                  fs = yield* FileSystem.FileSystem;
                const root = config.stateDir + "/checkout";
                yield* fs.makeDirectory(root, { recursive: true });
                if (originRoot) {
                  yield* git(root, "clone", "--local", originRoot, ".");
                  yield* git(
                    root,
                    "remote",
                    "set-url",
                    "origin",
                    "https://example.invalid/synthetic/project.git",
                  );
                } else {
                  yield* git(root, "init", "-b", "main");
                  yield* git(
                    root,
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Synthetic",
                  );
                  yield* git(
                    root,
                    "remote",
                    "add",
                    "origin",
                    "https://example.invalid/synthetic/project.git",
                  );
                  originRoot = root;
                }
                yield* fixture.dispatch({
                  type: "project.create",
                  projectId: id,
                  commandId: CommandId.make("init"),
                  title: machine,
                  workspaceRoot: root,
                  createdAt: yield* fixture.now,
                });
                const store = yield* RemoteAgentStore,
                  sql = yield* SqlClient.SqlClient,
                  query = yield* ProjectionSnapshotQuery;
                const reach = yield* Reach,
                  auth = yield* Auth.EnvironmentAuth,
                  secrets = yield* Secrets.ServerSecretStore;
                const issue = (holder: string) =>
                  auth.issueSession({
                    subject: linkTokenSubject(holder),
                    scopes: [AuthOrchestrationOperateScope],
                  });
                const save = (peer: string, session: Effect.Success<ReturnType<typeof issue>>) =>
                  secrets.set(
                    agentMachineSecretName(peer),
                    new TextEncoder().encode(
                      JSON.stringify({
                        token: session.token,
                        expiresAt: DateTime.formatIso(session.expiresAt),
                        tagged: true,
                      }),
                    ),
                  );
                const toolkit = yield* ThreadsToolkit.pipe(
                  Effect.provide(ThreadsToolkitHandlersLive),
                );
                const message = (scope: ThreadId, text: string) =>
                  toolkit
                    .handle("cp_agent_message", {
                      to: coordinator,
                      message: text,
                      notifyCoordinator: false,
                    })
                    .pipe(
                      Stream.unwrap,
                      Stream.runCollect,
                      Effect.flatMap((chunk) => decodePeerMessage(chunk.at(-1)?.result)),
                      Effect.provideService(McpInvocationContext, {
                        environmentId: descriptor.environmentId,
                        threadId: scope,
                        providerSessionId: "synthetic-session",
                        providerInstanceId: ProviderInstanceId.make("codex"),
                        capabilities: new Set(["agents"] as const),
                        issuedAt: 0,
                      }),
                      Effect.provide(runtimeLayer),
                    );
                const send = (dest: string, input: unknown, sender = worker) =>
                  reach.call(
                    { id: dest, label: dest },
                    "agent.peers",
                    input,
                    { threadId: sender, threadTitle: "Worker" },
                    Schema.Unknown,
                    { fresh: true },
                  );
                const management = yield* ProjectCoordinatorMove;
                const manage = (
                  operation: "preflight" | "move" | "rollback",
                  approvalDigest?: string,
                ) =>
                  management.manage({
                    action: "coordinatorMove",
                    operation,
                    projectId: id,
                    destinationId: "target",
                    moveId: move,
                    ...(approvalDigest ? { approvalDigest } : {}),
                  });
                return {
                  fixture,
                  store,
                  sql,
                  reach,
                  query,
                  machine,
                  save,
                  issue,
                  send,
                  message,
                  manage,
                };
              }),
              env,
            );
          });
        const src = yield* setup("origin", origin),
          dst = yield* setup("target", target),
          guest = yield* setup("worker", workerProject);
        for (const holder of [src, dst, guest])
          for (const issuer of [src, dst, guest]) {
            if (holder.machine !== issuer.machine)
              yield* holder.save(issuer.machine, yield* issuer.issue(holder.machine));
          }
        yield* src.fixture.createThread(origin, coordinator, "Coordinator");
        yield* src.fixture.dispatch({
          type: "project.meta.update",
          projectId: origin,
          commandId: CommandId.make("mark"),
          assistant: { coordinatorThreadId: coordinator },
        });
        const attachWorker = (host: typeof src, home: ProjectId, id: ThreadId) =>
          Effect.gen(function* () {
            yield* guest.fixture.createThread(workerProject, id, "Worker");
            yield* guest.fixture.dispatch({
              type: "thread.message.user.append",
              threadId: id,
              commandId: CommandId.make("prompt-" + id),
              createdAt: yield* guest.fixture.now,
              message: {
                messageId: MessageId.make("prompt-" + id),
                text: "Synthetic task",
                attachments: [],
                source: {
                  kind: "agent",
                  threadId: coordinator,
                  threadTitle: "Coordinator",
                  placementHome: { machineId: host.machine, projectId: home },
                },
              },
            });
            yield* host.store.put(
              makeRecord({
                threadId: id,
                homeProjectId: home,
                creatorThreadId: coordinator,
                machineId: "worker",
                peerProjectId: workerProject,
              }),
            );
          });
        yield* attachWorker(src, origin, worker);
        const checked = (yield* src.manage("preflight")).coordinatorMove;
        expect(checked?.ready, checked?.detail).toBe(true);
        const activated = (yield* src.manage("move", checked?.approvalDigest)).coordinatorMove;
        expect(activated?.phase, activated?.detail).toBe("active");
        expect((yield* dst.store.listForMove).map((record) => record.threadId)).toEqual([worker]);
        const reply = {
          threadId: worker,
          projectId: workerProject,
          action: "message",
          thread: coordinator,
          message: "Synthetic reply after move",
          notify: false,
        };
        yield* guest.message(worker, reply.message);
        yield* guest.message(worker, reply.message);
        const messages = (query: typeof dst.query, sender = worker) =>
          query
            .getThreadDetailById(coordinator)
            .pipe(
              Effect.map((record) =>
                Option.getOrThrow(record).messages.filter((m) => m.source?.threadId === sender),
              ),
            );
        const delivered = yield* messages(dst.query);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.text).toContain(reply.message);
        expect(yield* messages(src.query)).toHaveLength(0);
        expect((yield* Effect.result(dst.send("origin", reply)))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(guest.send("origin", { ...reply, projectId: "other" })))._tag,
        ).toBe("Failure");
        yield* dst.sql`INSERT INTO project_move_receipts (project_id,peer_id,peer_project_id,move_id,role,phase) VALUES (${target},'origin',${origin},'replacement','source','rolled-back')`;
        expect((yield* Effect.result(guest.send("origin", reply)))._tag).toBe("Failure");
        yield* dst.sql`DELETE FROM project_move_receipts WHERE move_id='replacement'`;
        // A queued peer message must be consumed before the coordinator can move back.
        // Exercise the durable delivery and turn lifecycle without starting a model provider.
        const pendingReply = delivered[0]!;
        const createdAt = yield* dst.fixture.now;
        yield* dst.fixture.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(agentDeliveryStartId(pendingReply.id)),
          threadId: coordinator,
          message: {
            messageId: pendingReply.id,
            role: "user",
            text: pendingReply.text,
            attachments: [],
            ...(pendingReply.source ? { source: pendingReply.source } : {}),
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });
        for (const status of ["running", "stopped"] as const) {
          yield* dst.fixture.dispatch({
            type: "thread.session.set",
            threadId: coordinator,
            commandId: CommandId.make("synthetic-session-" + status),
            createdAt,
            session: {
              threadId: coordinator,
              status,
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: status === "running" ? TurnId.make("reply-turn") : null,
              lastError: null,
              updatedAt: createdAt,
            },
          });
        }
        const laterWorker = ThreadId.make("destination-worker");
        yield* attachWorker(dst, target, laterWorker);
        const rolledBack = (yield* src.manage("rollback")).coordinatorMove;
        expect(rolledBack?.phase, rolledBack?.detail).toBe("rolled-back");
        expect(yield* dst.store.listForMove).toHaveLength(0);
        yield* guest.message(worker, "Synthetic reply after return");
        expect(yield* messages(src.query)).toHaveLength(2);
        yield* guest.message(laterWorker, "Reply from agent placed at destination");
        expect(yield* messages(src.query, laterWorker)).toHaveLength(1);
      }),
    ),
);
