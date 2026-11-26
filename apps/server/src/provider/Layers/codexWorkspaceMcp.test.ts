import * as Effect from "effect/Effect";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { probeCodexWorkspaceMcp } from "./codexWorkspaceMcp.ts";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./CodexProvider.ts", async () => {
  const Effect = await import("effect/Effect");
  return { withCodexAppServerClient: () => Effect.succeed({ client: mock }) };
});

beforeEach(() => mock.request.mockReset());

it("requires a live tool listing on a turn-free scratch thread bound to the selected instance", async () => {
  const config = { mcp_servers: { example: { url: "https://example.test/mcp" } } };
  mock.request
    .mockReturnValueOnce(Effect.succeed({ config }))
    .mockReturnValueOnce(Effect.succeed({ config }))
    .mockReturnValueOnce(Effect.succeed({ thread: { id: "scratch-thread" } }))
    .mockReturnValueOnce(
      Effect.succeed({
        data: [{ name: "example", runtimeStatus: "connected", tools: { synthetic: {} } }],
      }),
    );
  const result = probeCodexWorkspaceMcp({ cwd: "/scratch", binaryPath: "codex" }, "/project");
  expect(
    await Effect.runPromise(result.pipe(Effect.scoped, Effect.provide(NodeServices.layer))),
  ).toBe(true);
  expect(mock.request.mock.calls).toEqual([
    ["config/read", { cwd: "/scratch" }],
    ["config/read", { cwd: "/project" }],
    [
      "thread/start",
      { cwd: "/scratch", sandbox: "read-only", approvalPolicy: "never", ephemeral: true },
    ],
    ["mcpServerStatus/list", { serverName: "example", detail: "full", threadId: "scratch-thread" }],
  ]);
});
