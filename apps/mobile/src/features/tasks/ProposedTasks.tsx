import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { formatTaskHome } from "@t3tools/client-runtime/state/projects";
import type { Task } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { RowSeparator, symbol, TaskCard, TaskCheckbox, useTaskPalette } from "./taskUi";
import type { TaskActions } from "./useMobileTasks";

// Fork-owned. Coordinator proposals, set apart from the user's own tasks:
// dashed boxes, a label naming who proposed them, Add and dismiss per row.

export function ProposedTasks(props: {
  readonly tasks: ReadonlyArray<Task>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly today: string;
  readonly actions: TaskActions;
  /** `card` sits in a coordinator thread; `list` heads the Today view. */
  readonly variant: "list" | "card";
}) {
  const { tasks, projects, today, actions } = props;
  if (tasks.length === 0) return null;
  const sources = new Set(tasks.map((task) => task.proposal?.projectId));
  const sourceProject =
    sources.size === 1 ? projects.find((p) => p.id === tasks[0]!.proposal?.projectId) : null;
  const card = props.variant === "card";
  const label = card
    ? "Proposed tasks"
    : sourceProject != null
      ? `Proposed by ${sourceProject.title} coordinator`
      : "Proposed by coordinators";
  const addAll =
    tasks.length > 1 ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tasks.length === 2 ? "Add both" : "Add all"}
        onPress={() => {
          for (const task of tasks) void actions.respond(task, true);
        }}
        className="ml-auto min-h-11 justify-center pl-3"
      >
        <Text className="text-[14px] font-t3-bold text-foreground">
          {tasks.length === 2 ? "Add both" : "Add all"}
        </Text>
      </Pressable>
    ) : null;

  const rows = tasks.map((task, index) => {
    const source = projects.find((p) => p.id === task.proposal?.projectId);
    return (
      <View key={task.id}>
        {index > 0 ? <RowSeparator inset={card ? 16 : 52} /> : null}
        <ProposedTaskRow
          task={task}
          card={card}
          meta={
            card && source !== undefined
              ? `${source.title} coordinator · ${formatTaskHome(task.home, today)}`
              : formatTaskHome(task.home, today)
          }
          actions={actions}
        />
      </View>
    );
  });

  if (card) {
    return (
      <View className="my-2 rounded-2xl bg-card px-4 pb-2 pt-1">
        <View className="flex-row items-center gap-1.5">
          <SymbolView
            name={symbol("checklist")}
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
          <Text className="text-[13px] font-t3-medium text-foreground-muted">
            {label} · {tasks.length}
          </Text>
          {addAll}
        </View>
        {rows}
      </View>
    );
  }
  return (
    <View>
      <View className="flex-row items-center gap-1.5 pl-9 pr-5 pt-3">
        <Text className="text-[13px] font-t3-medium text-foreground-muted" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-[13px] tabular-nums text-foreground-tertiary">{tasks.length}</Text>
        {addAll}
      </View>
      <TaskCard>{rows}</TaskCard>
    </View>
  );
}

function ProposedTaskRow(props: {
  readonly task: Task;
  readonly card: boolean;
  readonly meta: string;
  readonly actions: TaskActions;
}) {
  const { task, actions, card } = props;
  const palette = useTaskPalette();
  return (
    <View className={cn("flex-row items-start", card ? "py-1" : "py-1 pl-1.5 pr-2")}>
      <View className={card ? "-ml-2.5" : undefined}>
        <TaskCheckbox
          checked={false}
          proposed
          label={`Proposed: ${task.title}`}
          onPress={() => void actions.respond(task, true)}
        />
      </View>
      <View className="min-w-0 flex-1 pt-[9px]">
        <Text className="text-[17px] font-t3-bold text-foreground" numberOfLines={card ? 2 : 1}>
          {task.title}
        </Text>
        <View className="flex-row items-center gap-1 pb-1 pt-0.5">
          {card ? (
            <SymbolView
              name={symbol("bubble.left", "chat_bubble")}
              size={11}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          ) : null}
          <Text className="shrink text-[14px] text-foreground-muted" numberOfLines={1}>
            {props.meta}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${task.title}`}
        onPress={() => void actions.respond(task, true)}
        className="h-11 justify-center px-2"
      >
        <View
          style={
            card
              ? {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  backgroundColor: palette.chip,
                  borderRadius: 16,
                  paddingHorizontal: 12,
                  height: 32,
                }
              : undefined
          }
        >
          {card ? (
            <SymbolView
              name={symbol("plus", "check")}
              size={11}
              tintColorClassName="accent-foreground"
              type="monochrome"
              weight="bold"
            />
          ) : null}
          <Text className="text-[15px] font-t3-bold text-foreground">Add</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Dismiss ${task.title}`}
        onPress={() => void actions.respond(task, false)}
        className="size-11 items-center justify-center"
      >
        <SymbolView
          name={symbol("xmark", "close")}
          size={13}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </View>
  );
}
