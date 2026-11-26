// @effect-diagnostics-next-line nodeBuiltinImport:off - X_OK and O_NONBLOCK are native flags.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem lacks executable access and nonblocking open.
import * as NodeFSP from "node:fs/promises";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import {
  HostProcessEnvironment,
  HostProcessHomeDirectory,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import type { AgentProjectReadiness, ServerProvider } from "@t3tools/contracts";

type ReadinessProject = {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
};

/** Codex settings also exist without MCP. Inspect section headers in a bounded regular file.
 * Open nonblocking so a malformed Project config cannot park the placement call on a FIFO. */
async function hasCodexMcpSection(path: string): Promise<boolean> {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
  ).catch(() => null);
  if (!handle) return false;
  try {
    if (!(await handle.stat()).isFile()) return false;
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /^[ \t]*\[mcp_servers\.[^\]\r\n]+\][ \t]*(?:#.*)?$/m.test(
      buffer.toString("utf8", 0, bytesRead),
    );
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

// Credential files are checked by metadata only. The probe never launches CLIs or contacts services.
export const makeProjectReadiness = Effect.gen(function* () {
  const env = yield* HostProcessEnvironment;
  const home = yield* HostProcessHomeDirectory;
  const platform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const info = (name: string) =>
    fs.stat(name).pipe(
      Effect.map((entry) => entry.type),
      Effect.orElseSucceed(() => null),
    );
  const file = (name: string) => info(name).pipe(Effect.map((type) => type === "File"));
  const present = (...names: string[]) => names.some((name) => Boolean(env[name]?.trim()));

  return Effect.fnUntraced(function* (
    project: ReadinessProject,
    provider: Pick<ServerProvider, "installed" | "enabled" | "availability" | "auth"> | undefined,
  ) {
    const { workspaceRoot } = project;
    const directory = (yield* info(workspaceRoot)) === "Directory";
    const git = project.repositoryIdentity && (yield* info(path.join(workspaceRoot, ".git")));
    const checkout =
      directory && (!project.repositoryIdentity || git === "Directory" || git === "File");
    let ghInstalled = false;
    for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
      const bin = path.join(dir, platform === "win32" ? "gh.exe" : "gh");
      if (
        (yield* file(bin)) &&
        (yield* Effect.promise(() =>
          NodeFSP.access(bin, NodeFS.constants.X_OK).then(
            () => true,
            () => false,
          ),
        ))
      ) {
        ghInstalled = true;
        break;
      }
    }

    return {
      checkout,
      gh:
        ghInstalled &&
        (present("GH_TOKEN", "GITHUB_TOKEN") ||
          (yield* file(path.join(env.GH_CONFIG_DIR || path.join(config, "gh"), "hosts.yml")))),
      provider:
        provider?.installed === true &&
        provider.enabled &&
        provider.availability !== "unavailable" &&
        provider.auth.status === "authenticated",
      sentry: present("SENTRY_AUTH_TOKEN") || (yield* file(path.join(home, ".sentryclirc"))),
      readReplica:
        present("DATABASE_URL_READONLY") ||
        (yield* file(path.join(config, "hometrace/read-replica.env"))),
      eas: present("EXPO_TOKEN") || (yield* file(path.join(home, ".expo/state.json"))),
      vercel:
        present("VERCEL_TOKEN") ||
        (yield* file(path.join(config, "com.vercel.cli/auth.json"))) ||
        (yield* file(path.join(home, "Library/Application Support/com.vercel.cli/auth.json"))),
      posthog: present("POSTHOG_PERSONAL_API_KEY", "POSTHOG_CLI_TOKEN"),
      mcp:
        (yield* file(path.join(workspaceRoot, ".mcp.json"))) ||
        (yield* Effect.promise(() =>
          hasCodexMcpSection(path.join(workspaceRoot, ".codex/config.toml")),
        )) ||
        (yield* Effect.promise(() =>
          hasCodexMcpSection(path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml")),
        )),
    } satisfies AgentProjectReadiness;
  });
});

const fixes = {
  checkout: "restore the registered Project checkout",
  gh: "install gh and configure its login",
  provider: "install and sign into the selected provider instance",
  sentry: "configure Sentry credentials",
  readReplica: "configure read replica credentials",
  eas: "configure EAS credentials",
  vercel: "configure Vercel credentials",
  posthog: "configure PostHog credentials",
  mcp: "restore MCP configuration",
} satisfies Record<keyof AgentProjectReadiness, string>;

export function missingReadiness(candidate: AgentProjectReadiness, home: AgentProjectReadiness) {
  const missing = (Object.keys(fixes) as (keyof typeof fixes)[]).filter(
    (key) =>
      !candidate[key] && (key === "checkout" || key === "gh" || key === "provider" || home[key]),
  );
  return missing.length ? missing.map((key) => fixes[key]).join(", ") : null;
}
