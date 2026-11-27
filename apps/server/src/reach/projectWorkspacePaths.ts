// @effect-diagnostics nodeBuiltinImport:off - resolve aliases and directory boundaries on the host.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// A new file or directory may not exist yet. Its nearest existing parent
// still tells us whether a workspace symlink leads into a fenced Project.
export async function actualPath(input: string, links = new Set<string>()): Promise<string> {
  try {
    return await NodeFSP.realpath(input);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    // realpath also returns ENOENT for a dangling link. A write follows it
    // and may create the missing target in another Project.
    const link = await NodeFSP.readlink(input).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EINVAL") return null;
      throw error;
    });
    if (link !== null) {
      if (links.has(input)) throw new Error("Workspace path contains a symlink loop.", { cause });
      links.add(input);
      return actualPath(NodePath.resolve(NodePath.dirname(input), link), links);
    }
    const parent = NodePath.dirname(input);
    if (parent === input) throw cause;
    return NodePath.join(await actualPath(parent, links), NodePath.basename(input));
  }
}

export function workspaceRootsOverlap(left: string, right: string) {
  const inside = (root: string, other: string) => {
    const relative = NodePath.relative(root, other);
    return (
      relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative)
    );
  };
  return inside(left, right) || inside(right, left);
}
