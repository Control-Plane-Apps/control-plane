import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessHomeDirectory,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { missingReadiness, makeProjectReadiness } from "./projectReadiness.ts";

it.effect("checks checkout, selected provider, executable and fixed configuration markers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "placement-readiness-" });
    const project = { workspaceRoot: root, repositoryIdentity: { canonicalKey: "test" } };
    const provider = { installed: true, enabled: true, auth: { status: "authenticated" as const } };
    const env = { PATH: root, GH_TOKEN: "fixture", SENTRY_AUTH_TOKEN: "fixture" };
    yield* fs.makeDirectory(path.join(root, ".codex"));
    yield* fs.writeFileString(path.join(root, ".codex/config.toml"), "model = 'fixture'");
    const projectReadiness = yield* makeProjectReadiness.pipe(
      Effect.provideService(HostProcessEnvironment, env),
      Effect.provideService(HostProcessHomeDirectory, root),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    const initial = yield* projectReadiness(project, undefined);
    expect(initial).toEqual({
      checkout: false,
      gh: false,
      provider: false,
      sentry: true,
      readReplica: false,
      eas: false,
      vercel: false,
      posthog: false,
      mcp: false,
    });
    yield* fs.makeDirectory(path.join(root, ".git"));
    const binary = path.join(root, "gh");
    yield* fs.writeFileString(binary, "fixture");
    yield* fs.chmod(binary, 0o700);
    yield* fs.writeFileString(
      path.join(root, ".codex/config.toml"),
      "[mcp_servers.fixture]\ncommand = 'test'",
    );
    const ready = yield* projectReadiness(project, provider);
    expect(missingReadiness({ ...ready, gh: false }, [])).toBeNull();
    expect(missingReadiness({ ...ready, sentry: false, mcp: false }, ["sentry", "mcp"])).toBe(
      "configure Sentry credentials, restore MCP configuration",
    );
    expect(missingReadiness(initial, ["gh"])).toContain(
      "install and sign into the selected provider instance",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
