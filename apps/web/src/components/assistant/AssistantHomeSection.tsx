import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AssistantHomeStatus, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { agentMachinesErrorMessage } from "../settings/AgentMachinesSettings.logic";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  currentHome,
  LOCAL_HOME,
  machineStateText,
  offlineHomeText,
  pendingMoveText,
  reclaimWarning,
  runsOnOptions,
} from "./assistantHome.logic";

// Fork-owned. Settings, Assistant, "Runs on": which of the user's linked
// machines runs the Assistant, and moving it. The server runs the move (see
// docs/internals/assistant-cross-server-reach.md); this shows its state.

export type AssistantHomeState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: string }
  | { readonly phase: "ready"; readonly status: AssistantHomeStatus };

/** Reads where the Assistant runs, from the environment the Assistant pages use. */
export function useAssistantHomeStatus(environmentId: EnvironmentId | null, connected: boolean) {
  const assistantHome = useAtomCommand(serverEnvironment.assistantHome, { reportFailure: false });
  const [state, setState] = useState<AssistantHomeState>({ phase: "loading" });

  const refresh = useCallback(async () => {
    if (environmentId === null || !connected) return;
    const result = await assistantHome({ environmentId, input: { action: "status" } });
    if (result._tag === "Success") setState({ phase: "ready", status: result.value });
    else if (!isAtomCommandInterrupted(result)) {
      setState({
        phase: "failed",
        error: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  }, [assistantHome, environmentId, connected]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The status RPC is the external system; its state lands only after the await.
    void refresh();
  }, [refresh]);

  const move = useCallback(
    async (to: string): Promise<AssistantHomeStatus | null> => {
      if (environmentId === null) return null;
      const result = await assistantHome({ environmentId, input: { action: "move", to } });
      if (result._tag === "Success") {
        setState({ phase: "ready", status: result.value });
        return result.value;
      }
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "The Assistant did not move",
          description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
        });
        // A move that did not finish may have left it paused here: show that.
        void refresh();
      }
      return null;
    },
    [assistantHome, environmentId, refresh],
  );

  const reclaim = useCallback(async (): Promise<AssistantHomeStatus | null> => {
    if (environmentId === null) return null;
    const result = await assistantHome({ environmentId, input: { action: "reclaim" } });
    if (result._tag === "Success") {
      setState({ phase: "ready", status: result.value });
      return result.value;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "The Assistant was not taken back",
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
      void refresh();
    }
    return null;
  }, [assistantHome, environmentId, refresh]);

  return { state, refresh, move, reclaim };
}

export function AssistantHomeSection({
  localLabel,
  state,
  onMove,
  onReclaim,
}: {
  /** The machine these settings are read from. */
  readonly localLabel: string;
  readonly state: AssistantHomeState;
  readonly onMove: (to: string) => Promise<AssistantHomeStatus | null>;
  readonly onReclaim: () => Promise<AssistantHomeStatus | null>;
}) {
  const [pending, setPending] = useState<{ value: string; label: string } | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.phase !== "ready") {
    return (
      <SettingsSection title="Runs on">
        <SettingsRow
          title="Machine"
          description={
            state.phase === "loading"
              ? "Checking your machines…"
              : `Could not check where the Assistant runs: ${state.error}`
          }
        />
      </SettingsSection>
    );
  }
  const { status } = state;
  const options = runsOnOptions(status, `${localLabel} (this machine)`);
  const selected = currentHome(status);
  const offline = offlineHomeText(status);
  const moving = pendingMoveText(status);
  const takeBack = reclaimWarning(status);

  const confirmReclaim = async () => {
    setBusy(true);
    const done = await onReclaim();
    setBusy(false);
    setReclaiming(false);
    if (done !== null) {
      toastManager.add({
        type: "success",
        title: `Your Assistant runs on ${localLabel} again`,
      });
    }
  };

  const confirm = async () => {
    if (pending === null) return;
    setBusy(true);
    const moved = await onMove(pending.value);
    setBusy(false);
    setPending(null);
    if (moved !== null) {
      toastManager.add({
        type: "success",
        title: `Your Assistant now runs on ${pending.label}`,
        description: [
          "Its settings, schedules, memory and recent conversation moved with it.",
          ...(moved.notes ?? []),
        ].join(" "),
      });
    }
  };

  return (
    <SettingsSection title="Runs on">
      <SettingsRow
        title="Machine"
        description={
          status.machines.length === 0
            ? "Link another machine in Settings, Connections, Agent machines to run the Assistant there. An always-on machine keeps briefs and check-ins on time."
            : "The Assistant runs on one machine at a time and reaches Projects on every linked machine. An always-on machine keeps briefs and check-ins on time."
        }
        status={
          moving !== null ? (
            <span className="text-warning">{moving}</span>
          ) : offline !== null ? (
            <span className="text-warning">{offline}</span>
          ) : status.conflicts.length > 0 ? (
            <span className="text-warning">
              An Assistant also runs on {status.conflicts.map((entry) => entry.label).join(", ")}.
              Archive one so only one acts for you.
            </span>
          ) : null
        }
        control={
          <Select
            items={options.map(({ value, label }) => ({ value, label }))}
            value={selected ?? undefined}
            disabled={moving !== null || busy || status.machines.length === 0}
            onValueChange={(value) => {
              if (value === null || value === selected) return;
              const option = options.find((entry) => entry.value === value);
              if (option === undefined) return;
              if (option.blocked !== null) {
                toastManager.add({
                  type: "warning",
                  title: "Cannot move there yet",
                  description: option.blocked,
                });
                return;
              }
              setPending({ value, label: value === LOCAL_HOME ? localLabel : option.label });
            }}
          >
            <SelectTrigger size="xs" className="w-56" aria-label="Machine the Assistant runs on">
              <SelectValue placeholder="Not set up yet" />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className={cn(option.blocked !== null && "text-muted-foreground")}>
                    {option.label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {takeBack !== null ? (
        <SettingsRow
          title="Take the Assistant back"
          description={`${status.elsewhere?.label} cannot be reached. Run the Assistant on ${localLabel} instead.`}
          control={
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setReclaiming(true)}>
              Take it back
            </Button>
          }
        />
      ) : null}
      {status.machines.map((machine) => (
        <SettingsRow
          key={machine.id}
          title={machine.label}
          description={
            machine.hostsAssistant === true
              ? `${machineStateText(machine)}. Runs your Assistant.`
              : `${machineStateText(machine)}. ${machine.projects.length} ${machine.projects.length === 1 ? "Project" : "Projects"}.`
          }
          control={
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                machine.state === "online" ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
          }
        />
      ))}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Move your Assistant to {pending?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its settings, schedules, memory and last 200 messages move to {pending?.label}. It
              pauses on its current machine first, so only one Assistant ever acts for you, and the
              copy left there stays read-only. Tasks follow it. If anything fails, it stays where it
              is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button onClick={() => void confirm()} disabled={busy}>
              {busy ? "Moving…" : "Move Assistant"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={reclaiming} onOpenChange={(open) => !open && setReclaiming(false)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Take the Assistant back to {localLabel}?</AlertDialogTitle>
            <AlertDialogDescription>{takeBack}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmReclaim()} disabled={busy}>
              {busy ? "Taking it back…" : "Take it back"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
