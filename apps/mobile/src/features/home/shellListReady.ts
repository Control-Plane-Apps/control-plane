import { useEffect, useState } from "react";

import type { WorkspaceState } from "../../state/workspaceModel";

/**
 * How long a launch waits for the slowest environment's cached shell once the
 * first one has landed. Past this the list shows what it has.
 */
export const SHELL_CACHE_SETTLE_MS = 1_000;

// Once the list has shown in this app session it skips the settle wait, so a
// newly added environment or a remounted pane cannot hide loaded rows.
let shellListShown = false;

export type ShellListReadiness = "waiting" | "settling" | "ready";

/**
 * Cold launch reads each environment's cached shell separately. Showing the
 * list as soon as the first lands paints one environment's Projects and then
 * reflows when the next arrives, so the list waits until every enabled
 * environment has read its cache, or until the settle window runs out.
 */
export function shellListReadiness(
  state: Pick<WorkspaceState, "hasLoadedShellSnapshot" | "hasPendingCachedShell">,
  input: { readonly shownBefore: boolean; readonly settleExpired: boolean },
): ShellListReadiness {
  if (!state.hasLoadedShellSnapshot) return "waiting";
  if (state.hasPendingCachedShell && !input.shownBefore && !input.settleExpired) {
    return "settling";
  }
  return "ready";
}

export function useShellListReady(
  state: Pick<WorkspaceState, "hasLoadedShellSnapshot" | "hasPendingCachedShell">,
): boolean {
  const [settleExpired, setSettleExpired] = useState(false);
  const readiness = shellListReadiness(state, { shownBefore: shellListShown, settleExpired });
  useEffect(() => {
    if (readiness !== "settling") return;
    const id = setTimeout(() => setSettleExpired(true), SHELL_CACHE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [readiness]);
  useEffect(() => {
    if (readiness === "ready") shellListShown = true;
  }, [readiness]);
  return readiness === "ready";
}

/** Test hook: forget that the list has shown. */
export function resetShellListShownForTests(): void {
  shellListShown = false;
}
