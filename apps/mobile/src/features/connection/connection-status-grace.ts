export const CONNECTION_STATUS_GRACE_MS = 5_000;

/** One foreground interruption. Disposal cancels stale notifications. */
export function scheduleConnectionStatus(show: () => void): () => void {
  const timer = setTimeout(show, CONNECTION_STATUS_GRACE_MS);
  return () => clearTimeout(timer);
}

export function startConnectionStatusGrace(input: {
  readonly pending: boolean;
  readonly offline: boolean;
  readonly active: boolean;
  readonly show: (visible: boolean) => void;
}): () => void {
  input.show(input.pending && input.offline);
  if (!input.pending || input.offline || !input.active) return () => {};
  return scheduleConnectionStatus(() => input.show(true));
}
