/**
 * Quote-reply: a user message that answers one earlier message (or an excerpt
 * of it) in the same linear chat. The quote lives in the message text as a
 * Markdown blockquote header, so every client and every provider reads it
 * without special support, and history, resumed sessions and handoffs keep it:
 *
 *   > Replying to your earlier message [reply:msg-123]
 *   > The quoted first line, or the selected excerpt
 *
 *   The user's own text.
 *
 * The `[reply:<id>]` tag points the UI back at the original. Providers get the
 * header with the tag removed (`quoteReplyForProvider`). A Status `Re:` header,
 * when both are set, always comes first, so `parseStatusReply` is unchanged.
 */

/** What the model reads for a reply to its own (assistant or coordinator) message. */
export const QUOTE_REPLY_ASSISTANT_LABEL = "your earlier message";
/** What the model reads for a reply to one of the user's own messages. */
export const QUOTE_REPLY_SELF_LABEL = "my earlier message";
export const QUOTE_REPLY_LABEL_MAX_CHARS = 80;
/** A whole-message reply quotes only its first line, capped here. */
export const QUOTE_REPLY_FIRST_LINE_MAX_CHARS = 280;
/** An excerpt reply keeps the selection, capped here. */
export const QUOTE_REPLY_EXCERPT_MAX_CHARS = 2_000;

export interface QuoteReplyRef {
  readonly messageId: string;
  /** Noun phrase the model reads: the two constants above, or e.g. `Ada's message`. */
  readonly label: string;
  /** The quoted text: a first line or an excerpt. */
  readonly text: string;
}

export interface ParsedQuoteReply extends QuoteReplyRef {
  readonly body: string;
}

const MESSAGE_ID_PATTERN = /^[^\]\s]{1,200}$/;
const HEADER_LINE = /^> Replying to ([^\n]{1,80}?) \[reply:([^\]\s]{1,200})\][ \t]*$/;
const HEADER_LINE_GLOBAL = /^(>[ \t]*Replying to [^\n]{1,80}?) \[reply:[^\]\s]{1,200}\][ \t]*$/gm;
const ULTRATHINK_LINE = /^Ultrathink:[ \t]*\n/;

function clampLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
  if (flat.length === 0) return QUOTE_REPLY_ASSISTANT_LABEL;
  return flat.length <= QUOTE_REPLY_LABEL_MAX_CHARS
    ? flat
    : `${flat.slice(0, QUOTE_REPLY_LABEL_MAX_CHARS - 1).trimEnd()}…`;
}

function clampText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** The first non-empty line of a message, without leading Markdown markers, capped. */
export function quoteReplyFirstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((entry) =>
        entry
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
          .replace(/[*_`]+/g, "")
          .trim(),
      )
      .find((entry) => entry.length > 0 && !/^(?:```|---+|\*\*\*+)$/.test(entry)) ?? "";
  return clampText(line, QUOTE_REPLY_FIRST_LINE_MAX_CHARS);
}

/** Normalizes a quote for storage: trimmed, capped, blank lines collapsed. */
export function normalizeQuoteReplyText(text: string): string {
  return clampText(
    text.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n"),
    QUOTE_REPLY_EXCERPT_MAX_CHARS,
  );
}

/** The stored message text: the quote header, a blank line, then the body. */
export function quoteReplyText(ref: QuoteReplyRef, body: string): string {
  if (!MESSAGE_ID_PATTERN.test(ref.messageId)) return body;
  const quote = normalizeQuoteReplyText(ref.text);
  const lines = quote.length === 0 ? [] : quote.split("\n").map((line) => `> ${line}`.trimEnd());
  return [
    `> Replying to ${clampLabel(ref.label)} [reply:${ref.messageId}]`,
    ...lines,
    "",
    body,
  ].join("\n");
}

/**
 * Splits a quote header off a message, or the body of a Status reply. Tolerates
 * the `Ultrathink:` line a Claude effort setting puts in front; it stays on the
 * body so nothing the user sent is lost.
 */
export function parseQuoteReply(text: string): ParsedQuoteReply | null {
  const ultrathink = ULTRATHINK_LINE.exec(text)?.[0] ?? "";
  const rest = text.slice(ultrathink.length);
  const newline = rest.indexOf("\n");
  const header = HEADER_LINE.exec(newline === -1 ? rest : rest.slice(0, newline));
  if (header === null) return null;
  const quoteLines: string[] = [];
  let cursor = newline === -1 ? rest.length : newline + 1;
  while (cursor < rest.length) {
    const end = rest.indexOf("\n", cursor);
    const line = rest.slice(cursor, end === -1 ? rest.length : end);
    if (!line.startsWith(">")) break;
    quoteLines.push(line.replace(/^> ?/, ""));
    cursor = end === -1 ? rest.length : end + 1;
  }
  // The blank line separating the quote from the body.
  if (rest.startsWith("\n", cursor)) cursor += 1;
  return {
    label: header[1]!.trim(),
    messageId: header[2]!,
    text: quoteLines.join("\n"),
    body: `${ultrathink}${rest.slice(cursor)}`,
  };
}

/**
 * What a provider reads: the quote stays, the `[reply:<id>]` tag goes. Applied
 * where every provider's input passes, so Claude, Codex and the rest see the
 * same `> Replying to …:` blockquote.
 */
export function quoteReplyForProvider(text: string): string {
  if (!text.includes("[reply:")) return text;
  return text.replace(HEADER_LINE_GLOBAL, "$1:");
}

/** A plain-text preview of a reply: the body only (titles, previews, notifications). */
export function stripQuoteReplyHeader(text: string): string {
  return parseQuoteReply(text)?.body ?? text;
}
