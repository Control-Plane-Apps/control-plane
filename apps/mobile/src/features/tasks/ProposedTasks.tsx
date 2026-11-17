import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { addAllProposalsLabel, formatTaskHome } from "@t3tools/client-runtime/state/projects";
import type { Task } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { RowSeparator, symbol, TaskCard, TaskCheckbox } from "./taskUi";
import type { TaskActions } from "./useMobileTasks";

// Fork-owned. Proposals at the top of the range they are homed in, set apart
// from the user's own tasks: dashed boxes, a label naming who proposed them,
// Add and dismiss per row, and Add all.

export function ProposedTasks(props: {
  readonly tasks: ReadonlyArray<Task>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly today: string;
  readonly actions: TaskActions;
  /** Rows lit up briefly when opened from a chat's proposal block. */
  readonly highlightIds?: ReadonlySet<string>;
  /** Already inside a card (an Upcoming day): rows only, no card of their own. */
  readonly inline?: boolean;
}) {
  const { tasks, projects, today, actions } = props;
  if (tasks.length === 0) return null;
  const sources = new Set(tasks.map((task) => task.proposal?.projectId));
  const sourceProject =
    sources.size === 1 ? projects.find((p) => p.id === tasks[0]!.proposal?.projectId) : null;
  const label =
    sourceProject != null
      ? `Proposed by ${sourceProject.title} coordinator`
      : "Proposed by coordinators";
  const addAllLabel = addAllProposalsLabel(tasks.length);
  const rows = tasks.map((task, index) => (
    <View key={task.id}>
      {index > 0 ? <RowSeparator inset={52} /> : null}
      <ProposedTaskRow
        task={task}
        meta={formatTaskHome(task.home, today)}
        actions={actions}
        highlighted={props.highlightIds?.has(task.id) === true}
      />
    </View>
  ));
  return (
    <View>
      <View className="flex-row items-center gap-1.5 pl-9 pr-5 pt-3">
        <Text className="text-[13px] font-t3-medium text-foreground-muted" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-[13px] tabular-nums text-foreground-tertiary">{tasks.length}</Text>
        {tasks.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={addAllLabel}
            onPress={() => {
              for (const task of tasks) void actions.respond(task, true);
            }}
            className="ml-auto min-h-11 justify-center pl-3"
          >
            <Text className="text-[14px] font-t3-bold text-foreground">{addAllLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      {props.inline === true ? rows : <TaskCard>{rows}</TaskCard>}
    </View>
  );
}

function ProposedTaskRow(props: {
  readonly task: Task;
  readonly meta: string;
  readonly actions: TaskActions;
  readonly highlighted: boolean;
}) {
  const { task, actions } = props;
  return (
    <View
      className={cn(
        "flex-row items-start py-1 pl-1.5 pr-2",
        props.highlighted && "bg-subtle-strong",
      )}
    >
      <TaskCheckbox
        checked={false}
        proposed
        label={`Proposed: ${task.title}`}
        onPress={() => void actions.respond(task, true)}
      />
      <View className="min-w-0 flex-1 pt-[9px]">
        <Text className="text-[17px] font-t3-bold text-foreground">{task.title}</Text>
        <View className="flex-row items-center gap-1 pb-1 pt-0.5">
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
        <Text className="text-[15px] font-t3-bold text-foreground">Add</Text>
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
