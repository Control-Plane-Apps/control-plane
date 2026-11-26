import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
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

  it.effect(
    "requires operational MCP evidence, and does not query MCP for Projects without the requirement",
    () =>
      Effect.gen(function* () {
        const read = vi.fn(() => true);
        const verify = (required: boolean, connected?: Effect.Effect<boolean>) =>
          verifyProjectIntegrations(
            required ? ["mcp"] : [],
            "/synthetic",
            "github.com/example/sample",
            connected,
          ).pipe(Effect.result);
        expect((yield* verify(true))._tag).toBe("Failure");
        expect((yield* verify(true, Effect.succeed(false)))._tag).toBe("Failure");
        expect((yield* verify(false, Effect.sync(read)))._tag).toBe("Success");
        expect(read).not.toHaveBeenCalled();
        expect((yield* verify(true, Effect.sync(read)))._tag).toBe("Success");
        expect(read).toHaveBeenCalledOnce();
      }),
  );
  it.effect(
    "reads the named Expo Project without loading workspace code and rejects a different returned ID",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "readiness-test-" });
        const id = "00000000-0000-4000-8000-000000000000";
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(Response.json({ data: { app: { byId: { id } } } }))
          .mockResolvedValueOnce(
            Response.json({ data: { app: { byId: { id: "another-project" } } } }),
          );
        vi.stubGlobal("fetch", fetch);
        vi.stubEnv("EXPO_TOKEN", "synthetic-test-token");
        try {
          yield* fs.writeFileString(
            path.join(workspace, "app.json"),
            `{"expo":{"extra":{"eas":{"projectId":"${id}"}}}}`,
          );
          yield* fs.writeFileString(
            path.join(workspace, "app.config.js"),
            "throw new Error('must not load workspace code')",
          );
          const verify = () =>
            verifyProjectIntegrations(["eas"], workspace, "github.com/example/sample").pipe(
              Effect.result,
            );
          expect((yield* verify())._tag).toBe("Success");
          expect(fetch).toHaveBeenCalledWith(
            "https://api.expo.dev/graphql",
            expect.objectContaining({
              body: expect.stringContaining(id),
              redirect: "error",
            }),
          );
          expect((yield* verify())._tag).toBe("Failure");
        } finally {
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
