import { setTaskWeekStartsOn, type EnvironmentId, type TaskSyncStatus } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";

import { readLocalApi } from "../localApi";
import { projectEnvironment } from "./projects";
import { useTaskEnvironmentId } from "./tasks";
import { useAtomCommand } from "./use-atom-command";

const STATUS_POLL_MS = 30_000;

/**
 * The last status any surface read, per server, shared so Settings and Tasks
 * agree. The Tasks server's status also sets the week start.
 */
const useTaskSyncStatusStore = create<{
  readonly statuses: Readonly<Record<string, TaskSyncStatus>>;
  readonly set: (environmentId: EnvironmentId, status: TaskSyncStatus, isTasks: boolean) => void;
}>()((set) => ({
  statuses: {},
  set: (environmentId, status, isTasks) => {
    if (isTasks) setTaskWeekStartsOn(status.weekStartsOn);
    set((state) => ({ statuses: { ...state.statuses, [environmentId]: status } }));
  },
}));

/** Every server's last read Task Sync status, by environment id. */
export function useTaskSyncStatuses(): Readonly<Record<string, TaskSyncStatus>> {
  return useTaskSyncStatusStore((state) => state.statuses);
}

export function taskSyncErrorMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/**
 * Task Sync for one server (by default the server that holds Tasks): status
 * (polled, and refreshed when the window regains focus, as after checkout),
 * sign-in, sign-out and the subscription's checkout and portal pages. Each
 * server signs in on its own; Settings can target any connected server, so the
 * machine that runs the Assistant can be signed in from any client.
 */
export function useTaskSync(target?: EnvironmentId | null) {
  const tasksEnvironmentId = useTaskEnvironmentId();
  const environmentId = target ?? tasksEnvironmentId;
  const isTasks = environmentId === tasksEnvironmentId;
  const status = useTaskSyncStatusStore((state) =>
    environmentId === null ? null : (state.statuses[environmentId] ?? null),
  );
  const storeStatus = useTaskSyncStatusStore((state) => state.set);
  const setStatus = useCallback(
    (next: TaskSyncStatus) => {
      if (environmentId !== null) storeStatus(environmentId, next, isTasks);
    },
    [environmentId, isTasks, storeStatus],
  );
  const statusCommand = useAtomCommand(projectEnvironment.taskSyncStatus, { reportFailure: false });
  const requestCodeCommand = useAtomCommand(projectEnvironment.taskSyncRequestCode, {
    reportFailure: false,
  });
  const verifyCommand = useAtomCommand(projectEnvironment.taskSyncVerify, { reportFailure: false });
  const signOutCommand = useAtomCommand(projectEnvironment.taskSyncSignOut, {
    reportFailure: false,
  });
  const checkoutCommand = useAtomCommand(projectEnvironment.taskSyncCheckout, {
    reportFailure: false,
  });
  const portalCommand = useAtomCommand(projectEnvironment.taskSyncPortal, { reportFailure: false });
  const syncNowCommand = useAtomCommand(projectEnvironment.taskSyncNow, { reportFailure: false });
  const setPreviewCommand = useAtomCommand(projectEnvironment.taskSyncSetPreview, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <A>(
      execute: () => Promise<{ readonly _tag: string; readonly value?: A }>,
      fallback: string,
    ): Promise<Result<A>> => {
      setBusy(true);
      try {
        const result = await execute();
        if (result._tag === "Success") return { ok: true, value: result.value as A };
        if (isAtomCommandInterrupted(result as never)) return { ok: false, message: "" };
        return { ok: false, message: taskSyncErrorMessage(result, fallback) };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    const result = await statusCommand({ environmentId, input: undefined as never });
    if (result._tag === "Success") setStatus(result.value as TaskSyncStatus);
  }, [environmentId, setStatus, statusCommand]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const openUrl = async (url: string) => {
    const api = readLocalApi();
    if (api) await api.shell.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };

  const withStatus = async (
    execute: () => Promise<{ readonly _tag: string; readonly value?: unknown }>,
    fallback: string,
  ): Promise<Result<TaskSyncStatus>> => {
    const result = await run<TaskSyncStatus>(
      execute as () => Promise<{ readonly _tag: string; readonly value?: TaskSyncStatus }>,
      fallback,
    );
    if (result.ok) setStatus(result.value);
    return result;
  };

  const env = environmentId;
  return {
    environmentId: env,
    available: env !== null && status !== null && status.state !== "unavailable",
    status,
    busy,
    refresh,
    requestCode: (email: string) =>
      env === null
        ? Promise.resolve<Result<void>>({ ok: false, message: "" })
        : run<void>(
            () => requestCodeCommand({ environmentId: env, input: { email } }),
            "Couldn't send the code.",
          ),
    verify: (email: string, code: string) =>
      env === null
        ? Promise.resolve<Result<TaskSyncStatus>>({ ok: false, message: "" })
        : withStatus(
            () => verifyCommand({ environmentId: env, input: { email, code } }),
            "Couldn't sign in.",
          ),
    signOut: () =>
      env === null
        ? Promise.resolve<Result<TaskSyncStatus>>({ ok: false, message: "" })
        : withStatus(
            () => signOutCommand({ environmentId: env, input: undefined as never }),
            "Couldn't sign out.",
          ),
    setPreview: (enabled: boolean) =>
      env === null
        ? Promise.resolve<Result<TaskSyncStatus>>({ ok: false, message: "" })
        : withStatus(
            () => setPreviewCommand({ environmentId: env, input: { enabled } }),
            "Couldn't change the preview.",
          ),
    syncNow: () =>
      env === null
        ? Promise.resolve<Result<TaskSyncStatus>>({ ok: false, message: "" })
        : withStatus(
            () => syncNowCommand({ environmentId: env, input: undefined as never }),
            "Couldn't sync.",
          ),
    openCheckout: async (): Promise<Result<void>> => {
      if (env === null) return { ok: false, message: "" };
      const result = await run<{ url: string }>(
        () => checkoutCommand({ environmentId: env, input: undefined as never }),
        "Couldn't open checkout.",
      );
      if (!result.ok) return result;
      await openUrl(result.value.url);
      return { ok: true, value: undefined };
    },
    openPortal: async (): Promise<Result<void>> => {
      if (env === null) return { ok: false, message: "" };
      const result = await run<{ url: string }>(
        () => portalCommand({ environmentId: env, input: undefined as never }),
        "Couldn't open billing.",
      );
      if (!result.ok) return result;
      await openUrl(result.value.url);
      return { ok: true, value: undefined };
    },
  };
}
