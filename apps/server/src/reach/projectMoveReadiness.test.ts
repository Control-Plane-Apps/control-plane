// @effect-diagnostics nodeBuiltinImport:off - The fixture exercises native no-follow reads against an isolated checkout.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { verifyProjectIntegrations } from "./projectMoveReadiness.ts";
import { matchingWorkspaceMcpServers } from "../provider/Layers/codexWorkspaceMcp.ts";

describe("coordinator integration readiness", () => {
  it("requires the effective workspace server definitions to match before trusting runtime status", () => {
    const trusted = {
      external: { url: "https://example.test/mcp" },
      runner: { command: "system-runner" },
    };
    expect(matchingWorkspaceMcpServers(trusted, { external: trusted.external })).toEqual([
      "external",
    ]);
    expect(
      matchingWorkspaceMcpServers(trusted, {
        external: trusted.external,
        runner: { command: "./project-command" },
      }),
    ).toEqual([]);
    expect(
      matchingWorkspaceMcpServers(trusted, { external: { url: "https://other.test/mcp" } }),
    ).toEqual([]);
    expect(matchingWorkspaceMcpServers(trusted, { off: { enabled: false } })).toEqual([]);
  });

  it("requires operational MCP evidence, and does not query MCP for Projects without the requirement", async () => {
    const read = vi.fn(() => true);
    const verify = (required: boolean, connected?: Effect.Effect<boolean>) =>
      Effect.runPromise(
        verifyProjectIntegrations(
          required ? ["mcp"] : [],
          "/synthetic",
          "github.com/example/sample",
          connected,
        ).pipe(Effect.result),
      );
    expect((await verify(true))._tag).toBe("Failure");
    expect((await verify(true, Effect.succeed(false)))._tag).toBe("Failure");
    expect((await verify(false, Effect.sync(read)))._tag).toBe("Success");
    expect(read).not.toHaveBeenCalled();
    expect((await verify(true, Effect.sync(read)))._tag).toBe("Success");
    expect(read).toHaveBeenCalledOnce();
  });
  it("reads the named Expo Project without loading workspace code and rejects a different returned ID", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "readiness-test-"));
    const id = "00000000-0000-4000-8000-000000000000";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { app: { byId: { id } } } }))
      .mockResolvedValueOnce(Response.json({ data: { app: { byId: { id: "another-project" } } } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("EXPO_TOKEN", "synthetic-test-token");
    try {
      await fs.writeFile(
        path.join(workspace, "app.json"),
        JSON.stringify({ expo: { extra: { eas: { projectId: id } } } }),
      );
      await fs.writeFile(
        path.join(workspace, "app.config.js"),
        "throw new Error('must not load workspace code')",
      );
      const verify = () =>
        Effect.runPromise(
          verifyProjectIntegrations(["eas"], workspace, "github.com/example/sample").pipe(
            Effect.result,
          ),
        );
      expect((await verify())._tag).toBe("Success");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.expo.dev/graphql",
        expect.objectContaining({
          body: expect.stringContaining(id),
          redirect: "error",
        }),
      );
      expect((await verify())._tag).toBe("Failure");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
