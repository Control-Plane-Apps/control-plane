import {
  type EnvironmentId,
  type ProjectStatus,
  STATUS_REFRESH_TIMEOUT_MS,
  statusBoardSignature,
  statusRefreshBlockReason,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironment } from "../../state/environments";

// Fork-owned. State behind the Status header's refresh icon: ask the
// coordinator to refresh the board, then read as "Asked" until the board
// changes or the timeout passes. A second click while asked or sending does
// nothing, and the icon is blocked while the coordinator's machine is away.

export interface StatusRefresh {
  /** The request is out and the board has not changed yet. */
  readonly asked: boolean;
  /** Why the icon is disabled (machine offline), or null. */
  readonly blockedReason: string | null;
  readonly request: () => void;
}

export function useStatusRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly statuses: ReadonlyArray<ProjectStatus> | undefined;
  /** Delivers the refresh message to the coordinator; false when it was not accepted. */
  readonly send: () => boolean | Promise<boolean>;
}): StatusRefresh {
  const { environmentId, statuses, send } = input;
  const phase = useEnvironment(environmentId)?.connection.phase ?? null;
  const signature = useMemo(() => statusBoardSignature(statuses), [statuses]);
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
    if (inFlight.current || asked) return;
    inFlight.current = true;
    const before = signature;
    void Promise.resolve(send())
      .then((accepted) => {
        if (accepted) setBaseline(before);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [asked, send, signature]);

  return { asked, blockedReason: statusRefreshBlockReason(phase), request };
}
