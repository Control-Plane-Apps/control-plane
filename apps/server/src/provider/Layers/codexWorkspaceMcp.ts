import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { withCodexAppServerClient } from "./CodexProvider.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The machine-scoped client can attest only to servers with the same effective definition in
 * this checkout. Never start a workspace-supplied executable to test a move. */
export function matchingWorkspaceMcpServers(machine: unknown, workspace: unknown) {
  if (!record(machine) || !record(workspace)) return [];
  const enabled = Object.entries(workspace).filter(
    ([, definition]) => !(record(definition) && definition.enabled === false),
  );
  return enabled.every(
    ([name, definition]) =>
      record(definition) && NodeUtil.isDeepStrictEqual(definition, machine[name]),
  )
    ? enabled.map(([name]) => name)
    : [];
}

export const probeCodexWorkspaceMcp = Effect.fn("probeCodexWorkspaceMcp")(function* (
  input: Parameters<typeof withCodexAppServerClient>[0],
  workspace: string,
) {
  const { client } = yield* withCodexAppServerClient(input);
  const machine = yield* client.request("config/read", { cwd: input.cwd });
  const project = yield* client.request("config/read", { cwd: workspace });
  const names = matchingWorkspaceMcpServers(machine.config.mcp_servers, project.config.mcp_servers);
  if (!names.length) return false;
  // A threadless listing can return a cached catalog. Use a short-lived, turn-free runtime
  // in the isolated directory so the status reflects a live connection.
  const { thread } = yield* client.request("thread/start", {
    cwd: input.cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
  });
  for (const serverName of names) {
    const read = client
      .request("mcpServerStatus/list", { serverName, detail: "full", threadId: thread.id })
      .pipe(Effect.map((result) => result.data.find((row) => row.name === serverName)));
    let server = yield* read;
    while (server?.runtimeStatus === "starting" || server?.runtimeStatus === "notStarted") {
      yield* Effect.sleep("250 millis");
      server = yield* read;
    }
    if (
      server?.runtimeStatus !== "connected" ||
      server.toolsError ||
      !Object.keys(server.tools).length
    )
      return false;
  }
  return true;
});
