import { useAtomValue } from "@effect/atom-react";
import type { AssistantNeedsYouItem } from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { StackActions } from "@react-navigation/native";
import { CommandId, MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShells } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAppNavigation } from "../threads/sidebar-navigation-shell";
import { needsYouKey, recommendationReplyText, statusReplyDraft } from "./assistantScreen.logic";

// Fork-owned. What a Needs-you card does: answer with the recommendation (a
// message to that Project's coordinator, as the web's Status panel sends),
// Reply (the coordinator's composer, started with the question's header), or
// open the coordinator.

export type NeedsYouItem = AssistantNeedsYouItem<EnvironmentProject>;

/** Questions answered from this device, until the coordinator clears them. */
const sentNeedsYouKeysAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:assistant:sent-needs-you"),
);

export function useSentNeedsYouKeys(): ReadonlySet<string> {
  return useAtomValue(sentNeedsYouKeysAtom);
}

/** Opens a thread: replaces the detail pane beside the iPad sidebar, pushes on phone. */
export function useOpenThread(): (environmentId: EnvironmentId, threadId: ThreadId) => void {
  const navigation = useAppNavigation();
  const { usesSplitView } = useAdaptiveWorkspaceLayout().layout;
  return useCallback(
    (environmentId, threadId) => {
      const params = { environmentId: String(environmentId), threadId: String(threadId) };
      if (usesSplitView) navigation.navigate("Thread", params);
      else navigation.dispatch(StackActions.push("Thread", params));
    },
    [navigation, usesSplitView],
  );
}

export interface NeedsYouActions {
  readonly answer: (item: NeedsYouItem) => void;
  readonly reply: (item: NeedsYouItem) => void;
  readonly open: (item: NeedsYouItem) => void;
}

export function useNeedsYouActions(): NeedsYouActions {
  const threads = useThreadShells();
  const openThread = useOpenThread();

  const coordinatorOf = useCallback(
    (item: NeedsYouItem) => item.project.assistant?.coordinatorThreadId ?? null,
    [],
  );

  const answer = useCallback(
    (item: NeedsYouItem) => {
      const coordinatorThreadId = coordinatorOf(item);
      if (coordinatorThreadId === null) return;
      const key = needsYouKey(item.status, item.status.decision);
      const sent = appAtomRegistry.get(sentNeedsYouKeysAtom);
      if (sent.has(key)) return;
      const coordinator =
        threads.find(
          (thread) =>
            thread.environmentId === item.project.environmentId &&
            thread.id === coordinatorThreadId,
        ) ?? null;
      const metadata = makeQueuedMessageMetadata();
      appAtomRegistry.set(sentNeedsYouKeysAtom, new Set([...sent, key]));
      enqueueThreadOutboxMessage({
        environmentId: item.project.environmentId,
        threadId: coordinatorThreadId,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: recommendationReplyText(item.status, item.status.decision),
        attachments: [],
        ...(coordinator !== null
          ? {
              modelSelection: coordinator.modelSelection,
              runtimeMode: coordinator.runtimeMode,
              interactionMode: coordinator.interactionMode,
            }
          : {}),
        createdAt: metadata.createdAt,
      }).catch((error: unknown) => {
        const current = appAtomRegistry.get(sentNeedsYouKeysAtom);
        appAtomRegistry.set(
          sentNeedsYouKeysAtom,
          new Set([...current].filter((candidate) => candidate !== key)),
        );
        Alert.alert(
          "Could not send the answer",
          error instanceof Error ? error.message : "An error occurred.",
        );
      });
    },
    [coordinatorOf, threads],
  );

  const reply = useCallback(
    (item: NeedsYouItem) => {
      const coordinatorThreadId = coordinatorOf(item);
      if (coordinatorThreadId === null) return;
      const draftKey = scopedThreadKey(item.project.environmentId, coordinatorThreadId);
      // Never overwrite words the user already typed there.
      if (getComposerDraftSnapshot(draftKey).text.trim().length === 0) {
        setComposerDraftText(draftKey, statusReplyDraft(item.status, item.status.decision));
      }
      openThread(item.project.environmentId, coordinatorThreadId);
    },
    [coordinatorOf, openThread],
  );

  const open = useCallback(
    (item: NeedsYouItem) => {
      const coordinatorThreadId = coordinatorOf(item);
      if (coordinatorThreadId !== null) openThread(item.project.environmentId, coordinatorThreadId);
    },
    [coordinatorOf, openThread],
  );

  return useMemo(() => ({ answer, reply, open }), [answer, open, reply]);
}
