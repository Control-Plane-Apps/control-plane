import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentProjectReadiness, ServerProvider } from "@t3tools/contracts";

type ReadinessProject = {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
};

/** Codex settings also exist without MCP. Inspect section headers in a bounded regular file.
 * Open nonblocking so a malformed Project config cannot park the placement call on a FIFO. */
async function hasCodexMcpSection(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
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
export async function projectReadiness(
  project: ReadinessProject,
  provider: Pick<ServerProvider, "installed" | "enabled" | "availability" | "auth"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AgentProjectReadiness> {
  const { workspaceRoot } = project;
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const file = (path: string) =>
    stat(path).then(
      (info) => info.isFile(),
      () => false,
    );
  const present = (...names: string[]) => names.some((name) => Boolean(env[name]?.trim()));
  const directory = await stat(workspaceRoot).then(
    (info) => info.isDirectory(),
    () => false,
  );
  const git = join(workspaceRoot, ".git");
  const checkout =
    directory &&
    (!project.repositoryIdentity ||
      (await stat(git).then(
        (info) => info.isFile() || info.isDirectory(),
        () => false,
      )));
  const executable = async (command: string) => {
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const bin = join(dir, process.platform === "win32" ? command + ".exe" : command);
      if (
        (await file(bin)) &&
        (await access(bin, constants.X_OK).then(
          () => true,
          () => false,
        ))
      )
        return true;
    }
    return false;
  };

  return {
    checkout,
    gh:
      (await executable("gh")) &&
      (present("GH_TOKEN", "GITHUB_TOKEN") ||
        (await file(join(env.GH_CONFIG_DIR || join(config, "gh"), "hosts.yml")))),
    provider:
      provider?.installed === true &&
      provider.enabled &&
      provider.availability !== "unavailable" &&
      provider.auth.status === "authenticated",
    sentry: present("SENTRY_AUTH_TOKEN") || (await file(join(home, ".sentryclirc"))),
    readReplica:
      present("DATABASE_URL_READONLY") || (await file(join(config, "hometrace/read-replica.env"))),
    eas: present("EXPO_TOKEN") || (await file(join(home, ".expo/state.json"))),
    vercel:
      present("VERCEL_TOKEN") ||
      (await file(join(config, "com.vercel.cli/auth.json"))) ||
      (await file(join(home, "Library/Application Support/com.vercel.cli/auth.json"))),
    posthog: present("POSTHOG_PERSONAL_API_KEY", "POSTHOG_CLI_TOKEN"),
    mcp:
      (await file(join(workspaceRoot, ".mcp.json"))) ||
      (await hasCodexMcpSection(join(workspaceRoot, ".codex/config.toml"))) ||
      (await hasCodexMcpSection(join(env.CODEX_HOME || join(home, ".codex"), "config.toml"))),
  };
}

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
