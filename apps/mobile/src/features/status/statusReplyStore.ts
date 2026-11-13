import { useAtomValue } from "@effect/atom-react";
import { CommandId, MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { appAtomRegistry } from "../../state/atom-registry";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import type { StatusReplyTag } from "./projectStatus.logic";

// Fork-owned. The coordinator composer's "Re: <workstream>" chip, per thread,
// for this app session. The draft text itself stays in the composer drafts.

const statusReplyTagsAtom = Atom.make<Readonly<Record<string, StatusReplyTag>>>({}).pipe(
  Atom.keepAlive,
);

export function setStatusReplyTag(threadKey: string, tag: StatusReplyTag): void {
  const current = appAtomRegistry.get(statusReplyTagsAtom);
  appAtomRegistry.set(statusReplyTagsAtom, { ...current, [threadKey]: tag });
}

export function clearStatusReplyTag(threadKey: string): void {
  const current = appAtomRegistry.get(statusReplyTagsAtom);
  if (!(threadKey in current)) return;
  const { [threadKey]: _removed, ...rest } = current;
  appAtomRegistry.set(statusReplyTagsAtom, rest);
}

export function readStatusReplyTag(threadKey: string): StatusReplyTag | null {
  return appAtomRegistry.get(statusReplyTagsAtom)[threadKey] ?? null;
}

export function useStatusReplyTag(threadKey: string | null): StatusReplyTag | null {
  const tags = useAtomValue(statusReplyTagsAtom);
  return threadKey === null ? null : (tags[threadKey] ?? null);
}

/**
 * Sends a message to a thread through the same outbox the composer uses, so
 * it survives a dropped connection and shows as queued until delivered. The
 * thread's own model and modes apply.
 */
export async function sendThreadMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
}): Promise<void> {
  const metadata = makeQueuedMessageMetadata();
  await enqueueThreadOutboxMessage({
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text: input.text,
    attachments: [],
    createdAt: metadata.createdAt,
  });
}
