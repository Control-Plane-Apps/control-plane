import { useNavigation } from "@react-navigation/native";
import {
  anchorTaskProposalBlocks,
  encodeTaskHighlight,
  resolveTaskProposalBlock,
  summarizeTaskProposalBlock,
  taskProposalBlocksFromActivities,
  type TaskProposalAnchorEntry,
  type TaskProposalBlock,
} from "@t3tools/client-runtime/state/projects";
import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { symbol } from "./taskUi";
import { useMobileTaskStore, useTaskToday } from "./useMobileTasks";

// Fork-owned. The tasks a chat proposed, inline in its transcript: one block
// per turn of `cp_task_propose` calls, under that turn's reply. Tapping it
// opens Tasks on their range with the rows lit up.

/**
 * Draws a thread's proposal blocks under the feed rows they anchor to. Null
 * when the thread proposed nothing, so callers keep their own accessory.
 */
export function useThreadTaskProposalAccessory(input: {
  readonly threadId: ThreadId | null;
  readonly activities: OrchestrationThread["activities"] | null;
  readonly feed: ReadonlyArray<TaskProposalAnchorEntry>;
}): ((entry: { readonly id: string }) => ReactNode) | null {
  const blocks = useMemo(
    () => (input.activities === null ? [] : taskProposalBlocksFromActivities(input.activities)),
    [input.activities],
  );
  const anchored = useMemo(
    () => anchorTaskProposalBlocks(input.feed, blocks),
    [blocks, input.feed],
  );
  const threadId = input.threadId;
  const render = useCallback(
    (entry: { readonly id: string }) => {
      const list = anchored.get(entry.id);
      if (list === undefined || threadId === null) return null;
      return list.map((block) => (
        <TaskProposalBlockView key={block.id} block={block} threadId={threadId} />
      ));
    },
    [anchored, threadId],
  );
  return blocks.length === 0 ? null : render;
}

function TaskProposalBlockView(props: {
  readonly block: TaskProposalBlock;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const { tasks, source } = useMobileTaskStore();
  const today = useTaskToday();
  const summary = useMemo(
    () =>
      summarizeTaskProposalBlock(
        resolveTaskProposalBlock(props.block, tasks, props.threadId),
        today,
      ),
    [props.block, props.threadId, tasks, today],
  );
  // Proposals stay on the Mac: away from it, only the calls themselves are known.
  const live = source === "mac";
  const calls = props.block.calls.filter((call) => call.status !== "failed");
  const headline = live
    ? summary.headline
    : `Proposed ${calls.length} ${calls.length === 1 ? "task" : "tasks"}`;
  const items = live
    ? summary.items
    : calls
        .flatMap((call) => (call.title !== null ? [{ id: call.callId, title: call.title }] : []))
        .slice(0, 3);
  const more = live ? summary.moreCount : Math.max(0, calls.length - items.length);
  const view = live ? summary.view : null;
  return (
    <View className="px-4 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${headline}${live && summary.status ? `, ${summary.status}` : ""}. Open in Tasks`}
        disabled={view === null}
        onPress={() => {
          if (view === null) return;
          navigation.navigate("PlanTasks", {
            view,
            highlight: encodeTaskHighlight(summary.highlightIds),
          });
        }}
        className="rounded-2xl bg-card px-4 py-2.5"
      >
        <View className="flex-row items-center gap-1.5">
          <SymbolView
            name={symbol("checklist", "check")}
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
          <Text className="shrink text-[14px] font-t3-medium text-foreground" numberOfLines={1}>
            {headline}
          </Text>
          <View className="flex-1" />
          {live && summary.status.length > 0 ? (
            <Text className="text-[13px] tabular-nums text-foreground-muted" numberOfLines={1}>
              {summary.status}
            </Text>
          ) : null}
          {view !== null ? (
            <SymbolView
              name={symbol("chevron.right")}
              size={11}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
              weight="semibold"
            />
          ) : null}
        </View>
        {items.length > 0 ? (
          <View className="gap-0.5 pl-[18px] pt-1.5">
            {items.map((item) => (
              <Text
                key={item.id}
                className="text-[14px] text-foreground-secondary"
                numberOfLines={1}
              >
                {item.title}
              </Text>
            ))}
            {more > 0 ? (
              <Text className="text-[13px] text-foreground-muted">{more} more</Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}
