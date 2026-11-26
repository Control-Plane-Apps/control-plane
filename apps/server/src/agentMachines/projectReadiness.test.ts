import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { missingReadiness, projectReadiness } from "./projectReadiness.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("checks checkout, selected provider, executable and fixed configuration markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "placement-readiness-"));
  dirs.push(root);
  const project = { workspaceRoot: root, repositoryIdentity: { canonicalKey: "test" } };
  const provider = { installed: true, enabled: true, auth: { status: "authenticated" as const } };
  const env = { PATH: root, GH_TOKEN: "fixture", SENTRY_AUTH_TOKEN: "fixture" };
  await mkdir(join(root, ".codex"));
  await writeFile(join(root, ".codex/config.toml"), "model = 'fixture'");
  const initial = await projectReadiness(project, undefined, env, root);
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
  await mkdir(join(root, ".git"));
  const binary = join(root, process.platform === "win32" ? "gh.exe" : "gh");
  await writeFile(binary, "fixture");
  await chmod(binary, 0o700);
  await writeFile(join(root, ".codex/config.toml"), "[mcp_servers.fixture]\ncommand = 'test'");
  const ready = await projectReadiness(project, provider, env, root);
  expect(missingReadiness(ready, ready)).toBeNull();
  expect(missingReadiness({ ...ready, sentry: false, mcp: false }, ready)).toBe(
    "configure Sentry credentials, restore MCP configuration",
  );
  expect(missingReadiness(initial, ready)).toContain(
    "install and sign into the selected provider instance",
  );
});
