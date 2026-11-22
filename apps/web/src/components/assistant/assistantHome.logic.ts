import type { AssistantHomeMachine, AssistantHomeStatus } from "@t3tools/contracts";

// Fork-owned. Pure helpers for Settings, Assistant, "Runs on" and the reach
// picker's Projects on linked machines.

export const LOCAL_HOME = "local";

export interface RunsOnOption {
  readonly value: string;
  readonly label: string;
  /** Why it cannot be chosen now, or null. */
  readonly blocked: string | null;
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** One line under a machine: how it is and whether the Assistant can move there. */
export function machineStateText(machine: AssistantHomeMachine): string {
  switch (machine.state) {
    case "online":
      return machine.linksBack === false ? "Online, has not linked this machine back" : "Online";
    case "offline":
      return machine.lastSeenAt === undefined
        ? "Offline"
        : `Offline since ${timeOf(machine.lastSeenAt)}`;
    case "needs-relink":
      return "Needs linking again";
    case "incompatible":
      return "Needs an update";
  }
}

/** Why the Assistant cannot move to a machine now, or null. */
export function moveBlockedReason(machine: AssistantHomeMachine): string | null {
  if (machine.state !== "online") return `${machine.label}: ${machineStateText(machine)}.`;
  if (machine.hostsAssistant === true) return `${machine.label} already runs an Assistant.`;
  if (machine.linksBack !== true) {
    return `${machine.label} has to link this machine back first, so the Assistant there can reach the Projects here.`;
  }
  return null;
}

/**
 * The choices for "Runs on": this machine, then each linked machine. The
 * current home is always choosable (it is the selected value).
 */
export function runsOnOptions(status: AssistantHomeStatus, localLabel: string): RunsOnOption[] {
  const current = currentHome(status);
  return [
    { value: LOCAL_HOME, label: localLabel, blocked: null },
    ...status.machines.map((machine) => ({
      value: machine.id,
      label: machine.label,
      blocked: machine.id === current ? null : moveBlockedReason(machine),
    })),
  ];
}

/** The selected "Runs on" value, or null while no machine runs the Assistant. */
export function currentHome(status: AssistantHomeStatus): string | null {
  if (status.here) return LOCAL_HOME;
  return status.elsewhere?.id ?? null;
}

/** The Assistant's machine is offline: the client must not offer to create another. */
export function offlineHomeText(status: AssistantHomeStatus): string | null {
  if (status.here || status.elsewhere === null) return null;
  const machine = status.machines.find((entry) => entry.id === status.elsewhere?.id);
  if (machine === undefined || machine.state === "online") return null;
  const state = machineStateText(machine);
  return `Your Assistant runs on ${machine.label}, which is ${state.charAt(0).toLowerCase()}${state.slice(1)}.`;
}

export interface RemoteReachGroup {
  readonly machineId: string;
  readonly label: string;
  readonly state: string;
  readonly online: boolean;
  readonly projects: ReadonlyArray<{ readonly projectId: string; readonly title: string }>;
}

/** Projects on linked machines for the reach picker, by machine; machines with none are left out. */
export function remoteReachGroups(status: AssistantHomeStatus | null): RemoteReachGroup[] {
  if (status === null) return [];
  return status.machines
    .filter((machine) => machine.projects.length > 0)
    .map((machine) => ({
      machineId: machine.id,
      label: machine.label,
      state: machineStateText(machine),
      online: machine.state === "online",
      projects: machine.projects,
    }));
}

/**
 * The next reach list after toggling one Project. `null` means every Project,
 * including ones made later; it comes back when every known one is on.
 */
export function toggleReach(
  reach: ReadonlyArray<string> | null,
  allIds: ReadonlyArray<string>,
  projectId: string,
): ReadonlyArray<string> | null {
  const current = reach ?? allIds;
  const next = current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId];
  return allIds.every((id) => next.includes(id)) ? null : next;
}
