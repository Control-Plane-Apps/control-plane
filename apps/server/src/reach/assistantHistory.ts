// @effect-diagnostics nodeBuiltinImport:off - pure helpers over node:crypto hashing.
/**
 * The Assistant's whole conversation as it moves between machines: which
 * messages go, in what pages, how attachment ids are renamed for the new
 * thread, and the digest both sides compare before the move commits.
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module assistantHistory
 */
import * as NodeCrypto from "node:crypto";

import {
  parseAttachmentFileExtension,
  parseAttachmentUuid,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

/** At most this many messages per page. */
export const HISTORY_PAGE_MESSAGES = 200;
/** And at most this much text per page, so a page stays well under the op's body limit. */
export const HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
/** Attachment bytes per chunk (base64 adds a third). */
export const ATTACHMENT_CHUNK_BYTES = 6 * 1024 * 1024;

export interface MovingMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}

/** Oldest first, ties by id, so both machines walk the same order. */
export function orderHistory<M extends MovingMessage>(messages: ReadonlyArray<M>): M[] {
  return messages.toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId),
  );
}

/** Pages of at most HISTORY_PAGE_MESSAGES messages and about HISTORY_PAGE_BYTES of text. */
export function paginateHistory<M extends MovingMessage>(
  messages: ReadonlyArray<M>,
  limits: { readonly count: number; readonly bytes: number } = {
    count: HISTORY_PAGE_MESSAGES,
    bytes: HISTORY_PAGE_BYTES,
  },
): M[][] {
  const pages: M[][] = [];
  let page: M[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(message.text, "utf8") + 256;
    if (page.length > 0 && (page.length >= limits.count || bytes + size > limits.bytes)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(message);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/**
 * What both sides compare before commit: the ordered (role, time, text) of
 * every message. Ids are not part of it, so a renamed attachment or message
 * id never makes a whole history look different.
 */
export function historyDigest(messages: ReadonlyArray<MovingMessage>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const message of orderHistory(messages)) {
    hash.update(`${message.role}\u0000${message.createdAt}\u0000${message.text}\u0001`);
  }
  return hash.digest("hex");
}

/**
 * The id an attachment gets in the Assistant's new thread: the new thread's
 * segment, a stable uuid derived from the move and the old id (so a resent
 * chunk lands in the same file), and the old id's extension.
 */
export function movedAttachmentId(input: {
  readonly moveId: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): string | null {
  const segment = toSafeThreadAttachmentSegment(input.threadId);
  if (segment === null || parseAttachmentUuid(input.attachmentId) === null) return null;
  const hex = NodeCrypto.createHash("sha256")
    .update(`${input.moveId}:${input.attachmentId}`)
    .digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const extension = parseAttachmentFileExtension(input.attachmentId);
  return `${segment}-${uuid}${extension === null ? "" : `-${extension}`}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/** The key older builds' moves kept: role, time and text (their message ids were renamed). */
export function legacyKey(message: {
  readonly role: string;
  readonly createdAt: string;
  readonly text: string;
}): string {
  return `${message.role}\u0000${message.createdAt}\u0000${message.text}`;
}

/**
 * Which messages of an older copy the Assistant here lacks. A message here
 * with the same role, time and text covers one there only when it also holds
 * at least as many attachments: older builds moved text alone, so a picture
 * sent with words arrived as words only. Those come back as `thin`, the local
 * message they belong to, so its attachments can be brought in.
 */
export function legacyCoverage<
  L extends { readonly messageId: string; readonly attachmentCount: number },
  R extends MovingMessage,
>(
  local: ReadonlyArray<
    L & { readonly role: string; readonly createdAt: string; readonly text: string }
  >,
  remote: ReadonlyArray<R>,
): { readonly missing: R[]; readonly thin: Array<{ readonly message: R; readonly local: L }> } {
  const byKey = new Map<string, L>();
  for (const message of local) {
    const key = legacyKey(message);
    const known = byKey.get(key);
    if (known === undefined || message.attachmentCount > known.attachmentCount) {
      byKey.set(key, message);
    }
  }
  const missing: R[] = [];
  const thin: Array<{ readonly message: R; readonly local: L }> = [];
  for (const message of remote) {
    const match = byKey.get(legacyKey(message));
    if (match === undefined) missing.push(message);
    else if (match.attachmentCount < (message.attachments?.length ?? 0)) {
      thin.push({ message, local: match });
    }
  }
  return { missing, thin };
}

/** Is this attachment file name (with `.part` or not) one of the given thread segment's? */
export function attachmentFileThreadSegment(
  fileName: string,
  parse: (attachmentId: string) => string | null,
): string | null {
  const base = fileName.endsWith(".part") ? fileName.slice(0, -".part".length) : fileName;
  const dot = base.lastIndexOf(".");
  return parse(dot === -1 ? base : base.slice(0, dot));
}
