import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  STATUS_REFRESH_PROMPT,
  STATUS_REFRESH_TIMEOUT_MS,
  statusBoardSignature,
  statusRefreshBlockReason,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";
import { sendThreadMessage } from "./statusReplyStore";

// Fork-owned. State behind the Status header's refresh icon: ask the
// coordinator to refresh the board, then read as "Asked" until the board
// changes or the timeout passes. A tap while asked or sending does nothing,
// and the icon is blocked while the coordinator's machine is away.

export interface StatusRefresh {
  readonly asked: boolean;
  /** Why the icon is disabled (machine offline), or null. */
  readonly blockedReason: string | null;
  readonly request: () => void;
}

export function useStatusRefresh(project: EnvironmentProject): StatusRefresh {
  const coordinatorThreadId = project.assistant?.coordinatorThreadId ?? null;
  const phase = useEnvironmentPresentation(project.environmentId).presentation?.connection.phase;
  const signature = useMemo(
    () => statusBoardSignature(project.assistant?.statuses),
    [project.assistant?.statuses],
  );
  // The board as it was when asked; null before the first ask.
  const [baseline, setBaseline] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Asked until the board differs from how it was when asked.
  const asked = baseline !== null && signature === baseline;

  useEffect(() => {
    if (!asked) return;
    const timer = setTimeout(() => setBaseline(null), STATUS_REFRESH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [asked]);

  const request = useCallback(() => {
    if (inFlight.current || asked || coordinatorThreadId === null) return;
    inFlight.current = true;
    const before = signature;
    sendThreadMessage({
      environmentId: project.environmentId,
      threadId: coordinatorThreadId,
      text: STATUS_REFRESH_PROMPT,
    })
      .then(() => setBaseline(before))
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
      });
  }, [asked, coordinatorThreadId, project.environmentId, signature]);

  return { asked, blockedReason: statusRefreshBlockReason(phase ?? null), request };
}
