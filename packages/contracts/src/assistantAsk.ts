import * as Schema from "effect/Schema";

// Fork-owned. The Assistant's "ask every coordinator" fan-out. Each question
// is an ordinary request (a held `cp-send:` message with `replyTo`) in the
// coordinator's thread, so the coordinator's final message comes back to the
// Assistant through the normal result path, as a `cp-push:` message whose id
// embeds the request id and with it the ask id. The Assistant's thread also
// records the ask itself as an activity, so clients can draw one card per ask
// with its answers. Imports only effect so the index can export it freely.

export const ASSISTANT_ASK_ACTIVITY_KIND = "assistant.ask";

/** Marks the ask inside a request id: `cp-send:<coordinator>:ask:<askId>:<uuid>`. */
const ASK_SEGMENT = ":ask:";

export const AssistantAskId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{6,32}$/));
export type AssistantAskId = typeof AssistantAskId.Type;

/** The uuid slot of a request's send id: `ask:<askId>:<uuid>`. */
export function assistantAskSendSlot(askId: string, uuid: string): string {
  return `ask:${askId}:${uuid}`;
}

/** The ask a request or result message id belongs to, or null. */
export function assistantAskIdOf(messageId: string): string | null {
  const at = messageId.indexOf(ASK_SEGMENT);
  if (at < 0) return null;
  const rest = messageId.slice(at + ASK_SEGMENT.length);
  const end = rest.indexOf(":");
  const askId = end < 0 ? rest : rest.slice(0, end);
  return /^[a-z0-9]{6,32}$/.test(askId) ? askId : null;
}

export const AssistantAskActivityTarget = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  coordinatorThreadId: Schema.String,
});
export type AssistantAskActivityTarget = typeof AssistantAskActivityTarget.Type;

/** Payload of the `assistant.ask` activity on the Assistant's thread. */
export const AssistantAskActivityPayload = Schema.Struct({
  askId: AssistantAskId,
  question: Schema.String,
  /** A short title for lists ("Collapsible Assistant panel"); absent on older asks. */
  title: Schema.optional(Schema.String),
  targets: Schema.Array(AssistantAskActivityTarget),
});

/** Longest ask title a list shows. */
export const ASSISTANT_ASK_TITLE_MAX = 48;

const URL_PATTERN = /\b(?:https?|file):\/\/\S+/gi;
// Absolute, home-relative and Windows paths, and bare relative paths with a
// folder and an extension ("apps/web/src/x.tsx").
const PATH_PATTERN =
  /(?:~|\.{1,2})?\/(?:[\w.@%+-]+\/)*[\w.@%+-]+\/?|\b[A-Za-z]:\\\S+|\b(?:[\w.-]+\/)+[\w.-]+\.\w{1,8}\b/g;

function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * The short title lists show for an ask: the Assistant's own title when it
 * gave one, else the question's first sentence. Either way file paths and
 * URLs are dropped, so a list never shows "/Users/...".
 */
export function assistantAskTitle(question: string, title?: string | undefined): string {
  const clean = (text: string) =>
    text
      .replace(URL_PATTERN, " ")
      .replace(PATH_PATTERN, " ")
      // What a removed path leaves behind: "with a screenshot at :" and empty brackets.
      .replace(/\(\s*\)|\[\s*\]|"\s*"/g, " ")
      .replace(/\b(?:at|in|from|to|see)\s+(?=[,.;:)]|$)/gi, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[,;:.\s-]+|[,;:\s-]+$/g, "");
  const given = title === undefined ? "" : clean(title);
  if (given.length > 0) return clipWords(given, ASSISTANT_ASK_TITLE_MAX);
  let text = clean(question);
  // A lead-in naming who asked ("From Nick, with a screenshot: ...") is not the subject.
  const colon = text.indexOf(": ");
  if (colon > 0 && colon <= 60 && text.length - colon > 16) {
    text = text.slice(colon + 2).replace(/^["“']+/, "");
  }
  const firstSentence = /^(.+?[.?!])(?:\s|$)/.exec(text)?.[1] ?? text;
  const trimmed = firstSentence.replace(/[.]$/, "");
  const fallback = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return fallback.length > 0 ? clipWords(fallback, ASSISTANT_ASK_TITLE_MAX) : "Question";
}
export type AssistantAskActivityPayload = typeof AssistantAskActivityPayload.Type;

/** What a coordinator sees: who is asking and that its final message is the answer. */
export function assistantAskMessageText(question: string): string {
  return `The user's Assistant asks (your final message is sent back to it as the answer; keep it to a few lines):\n\n${question}`;
}

/** First line of a delivered result, which names the agent and outcome; the rest is the answer. */
export function assistantAskAnswerText(resultText: string): string {
  const firstBreak = resultText.indexOf("\n\n");
  return (firstBreak < 0 ? resultText : resultText.slice(firstBreak + 2)).trim();
}

// ── Pings ──────────────────────────────────────────────────────────

/** A heads-up the Assistant raises for the user, with up to two one-tap replies. */
export const ASSISTANT_PING_ACTIVITY_KIND = "assistant.ping";
export const ASSISTANT_PING_TITLE_MAX = 80;
export const ASSISTANT_PING_BODY_MAX = 240;
export const ASSISTANT_PING_LABEL_MAX = 24;
export const ASSISTANT_PING_REPLY_MAX = 400;

export const AssistantPingAction = Schema.Struct({
  /** Button text, such as "Pause them". */
  label: Schema.String,
  /** Sent to the Assistant as the user's message when tapped. */
  reply: Schema.String,
});
export type AssistantPingAction = typeof AssistantPingAction.Type;

/** Payload of the `assistant.ping` activity. "Not now" is always offered and sends nothing. */
export const AssistantPingPayload = Schema.Struct({
  pingId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.String),
  actions: Schema.Array(AssistantPingAction),
});
export type AssistantPingPayload = typeof AssistantPingPayload.Type;
