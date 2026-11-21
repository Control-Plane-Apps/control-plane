/**
 * Text for messages that cross servers. Fork-owned.
 *
 * @module reachText
 */

/** What a thread on another server is called here: "Assistant (on Mac mini)". */
export function remoteSenderTitle(caller: {
  readonly threadTitle: string;
  readonly label: string;
}): string {
  const title = caller.threadTitle.trim().length > 0 ? caller.threadTitle.trim() : "Agent";
  return `${title} (on ${caller.label})`;
}

/** The text a coordinator's ping or message reads as in the Assistant's thread. */
export function assistantNoteText(input: {
  readonly kind: "message" | "ping";
  readonly text: string;
  readonly from: string;
}): string {
  return input.kind === "ping"
    ? `${input.from} sent you a heads-up. Raise it with the user (cp_assistant_ping) only if it matters now; otherwise keep it for the next brief.\n\n${input.text}`
    : input.text;
}
