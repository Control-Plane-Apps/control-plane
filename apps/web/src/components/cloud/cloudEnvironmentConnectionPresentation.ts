import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

/**
 * Present the live supervisor state for an environment that is already in the
 * connection catalog. Catalog membership only means the environment is saved;
 * it does not mean the connection attempt succeeded.
 */
export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: "Connected",
        statusText: connectionStatusText(connection),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: "Connecting…",
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: "Reconnecting…",
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    // Not a failure: the machine is fine, this build just cannot talk to it.
    case "unsupported":
      return {
        buttonLabel: "Client not supported",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "error":
      return {
        buttonLabel: "Connection failed",
        statusText: connectionStatusText(connection),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: "Offline",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: "Not connected",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
  }
}

export type DiscoveredMachineAvailability = "checking" | "online" | "offline" | "error";

export interface DiscoveredMachinePresentation {
  /** Short reachability word for the row: Online, Offline, Unreachable, Checking…. */
  readonly reachability: string;
  /** When the relay last saw this machine, or when it was linked if never confirmed. */
  readonly lastSeen: string;
}

function formatShortDate(date: Date, now: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function formatAgo(timestamp: string, now: Date): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatShortDate(date, now);
}

/**
 * Describe another machine on the account for the opt-in list. The relay
 * reports whether the machine answers now (and when it checked); it keeps no
 * last-seen history, so an unreachable machine falls back to its link date.
 */
export function presentDiscoveredMachine(input: {
  readonly availability: DiscoveredMachineAvailability;
  readonly checkedAt: string | null;
  readonly linkedAt: string;
  readonly now: Date;
}): DiscoveredMachinePresentation {
  const reachability =
    input.availability === "online"
      ? "Online"
      : input.availability === "offline"
        ? "Offline"
        : input.availability === "error"
          ? "Unreachable"
          : "Checking…";
  const seen =
    input.availability === "online" && input.checkedAt !== null
      ? formatAgo(input.checkedAt, input.now)
      : null;
  if (seen !== null) return { reachability, lastSeen: `Seen ${seen}` };
  const linked = new Date(input.linkedAt);
  return {
    reachability,
    lastSeen: Number.isNaN(linked.getTime())
      ? "Not seen recently"
      : `Not seen recently · linked ${formatShortDate(linked, input.now)}`,
  };
}
