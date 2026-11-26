// @effect-diagnostics-next-line nodeBuiltinImport:off - Git NUL-delimited output must remain byte-exact.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - O_NOFOLLOW prevents following a replaced file.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The digest uses a single no-follow file handle.
import * as NodeFSP from "node:fs/promises";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import type { RepositoryIdentity } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Resolve native paths for the no-follow file handles.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const git = NodeUtil.promisify(NodeChildProcess.execFile);
const decode = new TextDecoder("utf-8", { fatal: true });

/** A prepared copy must preserve HEAD, branch, index, permissions and all tracked and
 * non-ignored untracked bytes. Only the digest and Git position leave the machine. */
export async function workspaceFingerprint(directory: string, repository?: RepositoryIdentity) {
  const root = await NodeFSP.realpath(directory);
  const run = async (...args: string[]) =>
    (
      await git("git", ["--no-optional-locks", ...args], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10000,
      })
    ).stdout;
  if (repository) {
    const url = decode
      .decode(await run("remote", "get-url", "--", repository.locator.remoteName))
      .trimEnd();
    if (normalizeGitRemoteUrl(url) !== repository.canonicalKey)
      throw new Error("The checkout belongs to a different repository.");
  }
  const branch = decode.decode(await run("symbolic-ref", "--short", "HEAD")).trimEnd();
  const commit = decode.decode(await run("rev-parse", "--verify", "HEAD")).trimEnd();
  const top = decode.decode(await run("rev-parse", "--show-toplevel")).trimEnd();
  if (root !== (await NodeFSP.realpath(top)))
    throw new Error("Select the registered Git checkout root.");
  const index = await run("ls-files", "--stage", "-z");
  const others = await run("ls-files", "--others", "--exclude-standard", "-z");
  const files = new Set<string>();
  for (const entry of decode.decode(index).split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) [a-f\d]+ 0\t([\s\S]+)$/.exec(entry);
    if (!match)
      throw new Error("Finish resolving conflicts or prepare a checkout without submodules.");
    files.add(match[2]!);
  }
  for (const entry of decode.decode(others).split("\0").filter(Boolean)) files.add(entry);
  const hash = NodeCrypto.createHash("sha256");
  hash.update(NodeCrypto.createHash("sha256").update(index).digest());
  hash.update(NodeCrypto.createHash("sha256").update(others).digest());
  const buffer = Buffer.allocUnsafe(128 * 1024);
  for (const name of [...files].sort()) {
    const path = NodePath.resolve(root, name);
    if (!path.startsWith(root + NodePath.sep)) throw new Error("Invalid repository path.");
    hash.update(JSON.stringify(name));
    const info = await NodeFSP.lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      hash.update("absent");
      continue;
    }
    if ((await NodeFSP.realpath(NodePath.dirname(path))) !== NodePath.dirname(path))
      throw new Error("Unexpected symlink parent.");
    if (info.isSymbolicLink()) {
      hash.update("link").update(
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readlink(path, { encoding: "buffer" }))
          .digest(),
      );
      continue;
    }
    if (!info.isFile()) throw new Error("Only regular files and symbolic links can be verified.");
    const handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("Workspace file changed during verification.");
      const content = NodeCrypto.createHash("sha256");
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        content.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (before.ctimeMs !== after.ctimeMs || before.size !== after.size)
        throw new Error("Workspace changed during verification.");
      hash.update(String(before.mode & 0o777)).update(content.digest());
    } finally {
      await handle.close();
    }
  }
  if (
    !(await run("ls-files", "--stage", "-z")).equals(index) ||
    !(await run("ls-files", "--others", "--exclude-standard", "-z")).equals(others) ||
    decode.decode(await run("rev-parse", "--verify", "HEAD")).trimEnd() !== commit ||
    decode.decode(await run("symbolic-ref", "--short", "HEAD")).trimEnd() !== branch
  )
    throw new Error("Repository changed during verification.");
  return { root, branch, commit, digest: hash.digest("hex") };
}
