// @effect-diagnostics nodeBuiltinImport:off - Bounded CLI probes use native timeout and no-follow file flags.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { AgentMachinesError, type AgentIntegration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const unavailable = (integration: AgentIntegration) =>
  new AgentMachinesError({
    detail: `Could not verify read-only ${integration} access for this Project on the destination.`,
  });

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readConfig(root: string, relative: string) {
  const file = NodePath.join(root, relative);
  // Configuration can come from a checkout. Inspect a bounded regular file without sourcing it.
  if ((await NodeFSP.realpath(NodePath.dirname(file))) !== NodePath.dirname(file))
    throw new Error();
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error();
    const buffer = Buffer.alloc(stat.size + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== stat.size) throw new Error();
    return buffer.subarray(0, stat.size).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function projectJson(root: string, relative: string) {
  return object(JSON.parse(await readConfig(root, relative)));
}

async function readJson(url: string, init: RequestInit) {
  // @effect-diagnostics-next-line globalFetch:off - Native AbortSignal bounds these Promise-based service probes.
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error();
  return object(await response.json());
}

/** Use the destination's own authentication. Never return CLI output or secret-bearing errors. */
async function probe(
  integration: Exclude<AgentIntegration, "mcp">,
  workspace: string,
  repository: string,
) {
  const directory = await NodeFSP.realpath(workspace);
  // Running a provider CLI inside the checkout can load executable Project configuration.
  const scratch = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "cplane-integration-readiness-"),
  );
  try {
    const env = { ...process.env, CI: "1", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
    const options = { cwd: scratch, timeout: 10_000, maxBuffer: 256 * 1024, env };
    switch (integration) {
      case "gh": {
        if (!/^github\.com\/[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error();
        const { stdout } = await run(
          "gh",
          ["repo", "view", repository, "--json", "nameWithOwner"],
          options,
        );
        if (
          "github.com/" + String(object(JSON.parse(stdout)).nameWithOwner).toLowerCase() !==
          repository.toLowerCase()
        )
          throw new Error();
        break;
      }
      case "sentry": {
        const org = process.env.SENTRY_ORG;
        const project = process.env.SENTRY_PROJECT;
        if (!org || !project) throw new Error();
        await run(
          "sentry-cli",
          ["releases", "list", "--org", org, "--project", project, "--raw"],
          options,
        );
        break;
      }
      case "vercel": {
        const { orgId, projectId } = await projectJson(directory, ".vercel/project.json");
        if (
          typeof orgId !== "string" ||
          typeof projectId !== "string" ||
          !/^[\w-]+$/.test(orgId) ||
          !/^prj_[\w-]+$/.test(projectId)
        )
          throw new Error();
        // Supply only the linked identifiers to the CLI. No Project code or config is copied.
        await NodeFSP.mkdir(NodePath.join(scratch, ".vercel"));
        await NodeFSP.writeFile(
          NodePath.join(scratch, ".vercel/project.json"),
          JSON.stringify({ orgId, projectId }),
        );
        await run("vercel", ["project", "inspect"], options);
        break;
      }
      case "eas": {
        const app = await projectJson(directory, "app.json").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return {};
          },
        );
        const expo = object(object(app).expo);
        const projectId = object(object(expo.extra).eas).projectId ?? process.env.EAS_PROJECT_ID;
        if (
          typeof projectId !== "string" ||
          !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(projectId)
        )
          throw new Error();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (process.env.EXPO_TOKEN) {
          headers.Authorization = "Bearer " + process.env.EXPO_TOKEN;
        } else {
          const auth = object((await projectJson(NodeOS.homedir(), ".expo/state.json")).auth);
          if (typeof auth.sessionSecret !== "string" || !auth.sessionSecret) throw new Error();
          headers["expo-session"] = auth.sessionSecret;
        }
        const response = await readJson("https://api.expo.dev/graphql", {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: "query ProjectReadiness($appId: String!) { app { byId(appId: $appId) { id } } }",
            variables: { appId: projectId },
          }),
        });
        if (response.errors || object(object(object(response.data).app).byId).id !== projectId)
          throw new Error();
        break;
      }
      case "readReplica": {
        const url = process.env.DATABASE_URL_READONLY || process.env.READ_REPLICA_URL;
        if (!url) throw new Error();
        const { stdout } = await run("psql", ["-X", "-w", "-Atc", "SHOW transaction_read_only"], {
          ...options,
          env: { ...env, PGDATABASE: url, PGCONNECT_TIMEOUT: "5" },
        });
        if (stdout.trim() !== "on") throw new Error();
        break;
      }
      case "posthog": {
        const secret = process.env.POSTHOG_PERSONAL_API_KEY || process.env.POSTHOG_CLI_TOKEN;
        const id = process.env.POSTHOG_PROJECT_ID;
        if (!secret || !id || !/^\d+$/.test(id)) throw new Error();
        const host = process.env.POSTHOG_HOST || "https://us.posthog.com";
        const url = new URL(host);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error();
        const result = await readJson(new URL(`/api/projects/${id}/`, url).href, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (String(result.id) !== id) throw new Error();
        break;
      }
    }
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

export function verifyProjectIntegrations(
  integrations: readonly AgentIntegration[],
  cwd: string,
  repository: string,
  verifyMcp?: Effect.Effect<boolean>,
) {
  return Effect.forEach(
    integrations,
    (integration) => {
      if (integration === "mcp")
        return (verifyMcp ?? Effect.succeed(false)).pipe(
          Effect.flatMap((verified) => (verified ? Effect.void : Effect.fail(unavailable("mcp")))),
        );
      return Effect.tryPromise({
        try: () => probe(integration, cwd, repository),
        catch: () => unavailable(integration),
      });
    },
    { discard: true },
  );
}
