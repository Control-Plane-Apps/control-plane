// @effect-diagnostics-next-line nodeBuiltinImport:off - Construct a real Git fixture for byte-level comparisons.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Copy the complete fixture including its Git index.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - These paths belong to the native fixture.
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { workspaceFingerprint } from "./workspaceFingerprint.ts";

it("requires matching staged, unstaged and untracked bytes in a prepared checkout", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cp-handoff-"));
  const source = NodePath.join(base, "source");
  const copy = NodePath.join(base, "copy");
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd: source });
  try {
    NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "handoff", source]);
    await NodeFSP.writeFile(NodePath.join(source, "tracked"), "initial");
    git("add", "tracked");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "initial",
    );
    await NodeFSP.writeFile(NodePath.join(source, "tracked"), "staged");
    git("add", "tracked");
    await NodeFSP.writeFile(NodePath.join(source, "tracked"), "unstaged");
    await NodeFSP.writeFile(NodePath.join(source, "untracked"), Buffer.from([0, 255, 1]));
    await NodeFSP.cp(source, copy, { recursive: true });
    const original = await workspaceFingerprint(source);
    expect((await workspaceFingerprint(copy)).digest).toBe(original.digest);
    await NodeFSP.writeFile(NodePath.join(copy, "untracked"), Buffer.from([0, 254, 1]));
    expect((await workspaceFingerprint(copy)).digest).not.toBe(original.digest);
    await NodeFSP.writeFile(NodePath.join(copy, "untracked"), Buffer.from([0, 255, 1]));
    NodeChildProcess.execFileSync("git", ["add", "tracked"], { cwd: copy });
    expect((await workspaceFingerprint(copy)).digest).not.toBe(original.digest);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
