import type { AgentWorkspaceCheckpoint, AgentWorkspaceProbe } from "@t3tools/contracts";

/** Only a named, clean checkout at a full commit is a resumable checkpoint. */
export function cleanWorkspace(root: string, status: string): AgentWorkspaceCheckpoint | null {
  let branch: string | undefined;
  let commit: string | undefined;
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.oid ")) commit = line.slice("# branch.oid ".length);
    else if (line !== "" && !line.startsWith("# ")) return null;
  }
  if (
    !branch ||
    branch === "(detached)" ||
    !commit ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
  )
    return null;
  return { root, branch, commit };
}

export function resumeBlocker(
  saved: AgentWorkspaceCheckpoint | null | undefined,
  probe: AgentWorkspaceProbe | null,
): string | null {
  if (!probe) return "Wake or reconnect the original machine and refresh.";
  if (!probe.idle) return "Wait for the original turn and pending requests to finish.";
  if (!saved)
    return "No clean named branch was verified before the machine went offline. Inspect the original thread and workspace.";
  if (!probe.workspace) return "The original checkout must be clean and on its named branch.";
  if (
    saved.root !== probe.workspace.root ||
    saved.branch !== probe.workspace.branch ||
    saved.commit !== probe.workspace.commit
  ) {
    return "Restore the original workspace, branch and commit, then refresh.";
  }
  return null;
}
