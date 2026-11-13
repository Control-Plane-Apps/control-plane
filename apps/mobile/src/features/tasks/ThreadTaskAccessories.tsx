import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  formatTaskHome,
  formatTaskTime,
  proposedTasksForProject,
  taskForThread,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { clearStatusReplyTag, useStatusReplyTag } from "../status/statusReplyStore";
import { ProposedTasks } from "./ProposedTasks";
import { symbol, useTaskPalette } from "./taskUi";
import { useMobileTaskStore, useTaskToday } from "./useMobileTasks";

// Fork-owned. What a thread shows about personal tasks: the task it works
// on (any thread) and, on a coordinator, the tasks it proposed.

export function ThreadTasksFooter(props: {
  readonly threadId: ThreadId;
  readonly project: EnvironmentProject | null;
  readonly isCoordinator: boolean;
}) {
  const navigation = useNavigation();
  const { available, tasks, projects, actions } = useMobileTaskStore();
  const today = useTaskToday();
  if (!available) return null;
  const linked = taskForThread(tasks, props.threadId);
  const proposals =
    props.isCoordinator && props.project !== null
      ? proposedTasksForProject(tasks, props.project.id)
      : [];
  if (linked === undefined && proposals.length === 0) return null;
  const reminder = linked?.home.kind === "date" ? linked.home.reminderTime : undefined;
  return (
    <View className="gap-2 pb-2">
      {linked !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Linked task, ${linked.title}. Open in Tasks`}
          onPress={() =>
            navigation.navigate("PlanTasks", {
              view: linked.home.kind === "period" ? linked.home.horizon : "today",
            })
          }
          className="min-h-11 flex-row items-center gap-2 rounded-xl bg-card px-3"
        >
          <SymbolView
            name={symbol("checklist", "check")}
            size={13}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
          <Text className="shrink text-[14px] font-t3-medium text-foreground" numberOfLines={1}>
            {linked.title}
          </Text>
          <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
            {formatTaskHome(linked.home, today)}
            {reminder !== undefined ? ` · ${formatTaskTime(reminder)}` : ""}
          </Text>
          <Text className="ml-auto text-[13px] text-foreground-muted">Open in Tasks</Text>
        </Pressable>
      ) : null}
      <ProposedTasks
        tasks={proposals}
        projects={projects}
        today={today}
        actions={actions}
        variant="card"
      />
    </View>
  );
}

/** "Re: Payments retry ×" above the coordinator's composer. */
export function StatusReplyChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const palette = useTaskPalette();
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  const tag = useStatusReplyTag(threadKey);
  if (tag === null) return null;
  return (
    <View className="flex-row px-4 pb-2">
      <View
        accessibilityLabel={`Replying to ${tag.title}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingLeft: 14,
          height: 36,
          borderRadius: 18,
          backgroundColor: palette.warningSurface,
          borderWidth: 1,
          borderColor: palette.warningBorder,
          maxWidth: "100%",
        }}
      >
        <Text
          className="shrink text-[14px] font-t3-medium"
          style={{ color: palette.warningText }}
          numberOfLines={1}
        >
          Re: {tag.title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop replying to ${tag.title}`}
          onPress={() => clearStatusReplyTag(threadKey)}
          hitSlop={6}
          className="h-9 w-9 items-center justify-center"
        >
          <SymbolView
            name={symbol("xmark", "close")}
            size={11}
            tintColor={palette.warningText}
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
    </View>
  );
}
