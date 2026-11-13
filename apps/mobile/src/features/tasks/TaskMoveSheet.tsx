import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  formatTaskHome,
  homeForMove,
  isHomeAtTarget,
  type TaskMoveTarget,
} from "@t3tools/client-runtime/state/projects";
import { addTaskDays, taskWeekday, type Task } from "@t3tools/contracts";
import { Fragment, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { TaskDatePicker } from "./TaskDatePicker";
import { RowSeparator, symbol, TaskCard, useTaskPalette } from "./taskUi";
import { useMobileTaskStore, useTaskToday } from "./useMobileTasks";

// Fork-owned. Moving between horizons without drag: a day, a commitment, or
// a backlog. One home per task.

type TaskMoveParams = {
  /** Comma-separated task ids; several when moving a selection. */
  readonly taskIds: string;
  /** Opens straight on the calendar (swipe left, Schedule). */
  readonly mode?: "schedule";
};

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface MoveEntry {
  readonly label: string;
  readonly hint?: string;
  readonly icon: "calendar" | "tray";
  readonly target: TaskMoveTarget;
}

/** Saturday of this weekend; today when it already is the weekend. */
function weekendDate(today: string): string {
  const weekday = taskWeekday(today);
  if (weekday === 6 || weekday === 0) return today;
  return addTaskDays(today, 6 - weekday);
}

/** Monday of next week. */
function nextWeekDate(today: string): string {
  const weekday = taskWeekday(today);
  return addTaskDays(today, (8 - weekday) % 7 || 7);
}

export function moveSections(today: string): ReadonlyArray<{
  readonly title: string | null;
  readonly entries: ReadonlyArray<MoveEntry>;
}> {
  const tomorrow = addTaskDays(today, 1);
  return [
    {
      title: null,
      entries: [
        { label: "Today", icon: "calendar", target: { kind: "today" } },
        {
          label: "Tomorrow",
          hint: WEEKDAYS_SHORT[taskWeekday(tomorrow)],
          icon: "calendar",
          target: { kind: "tomorrow" },
        },
        {
          label: "This weekend",
          icon: "calendar",
          target: { kind: "date", date: weekendDate(today) },
        },
        {
          label: "Next week",
          hint: "Mon",
          icon: "calendar",
          target: { kind: "date", date: nextWeekDate(today) },
        },
      ],
    },
    {
      title: "Commit",
      entries: [
        { label: "This week", icon: "tray", target: { kind: "commit", horizon: "week" } },
        { label: "This month", icon: "tray", target: { kind: "commit", horizon: "month" } },
        { label: "This year", icon: "tray", target: { kind: "commit", horizon: "year" } },
      ],
    },
    {
      title: "Backlog",
      entries: [
        { label: "General backlog", icon: "tray", target: { kind: "backlog", horizon: null } },
        { label: "Week backlog", icon: "tray", target: { kind: "backlog", horizon: "week" } },
        { label: "Month backlog", icon: "tray", target: { kind: "backlog", horizon: "month" } },
        { label: "Year backlog", icon: "tray", target: { kind: "backlog", horizon: "year" } },
      ],
    },
  ];
}

export function TaskMoveSheet({ route }: StaticScreenProps<TaskMoveParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const palette = useTaskPalette();
  const today = useTaskToday();
  const { tasks, actions } = useMobileTaskStore();
  const ids = new Set(route.params.taskIds.split(",").filter(Boolean));
  const moving = tasks.filter((task) => ids.has(task.id));
  const single: Task | undefined = moving.length === 1 ? moving[0] : undefined;
  const [picking, setPicking] = useState(route.params.mode === "schedule");
  const [pickedDate, setPickedDate] = useState(
    single?.home.kind === "date" ? single.home.date : today,
  );

  const move = (target: TaskMoveTarget) => {
    for (const task of moving) {
      void actions.move(task, homeForMove(target, task.home, today));
    }
    navigation.goBack();
  };

  return (
    <View className="flex-1 bg-sheet-solid">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View className="flex-row items-center px-5 pb-2 pt-5">
          <Text
            className="flex-1 text-[20px] font-t3-bold text-foreground"
            accessibilityRole="header"
          >
            {moving.length > 1 ? `Move ${moving.length} tasks` : "Move task"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => navigation.goBack()}
            className="size-11 items-center justify-center"
          >
            <SymbolView
              name={symbol("xmark", "close")}
              size={16}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
              weight="semibold"
            />
          </Pressable>
        </View>
        {moveSections(today).map((section, sectionIndex) => (
          <Fragment key={section.title ?? "days"}>
            {section.title !== null ? (
              <Text className="px-9 pb-2 pt-5 text-[13px] font-t3-medium text-foreground-muted">
                {section.title}
              </Text>
            ) : null}
            <TaskCard>
              {section.entries.map((entry, index) => {
                const checked =
                  single !== undefined && isHomeAtTarget(single.home, entry.target, today);
                return (
                  <View key={entry.label}>
                    {index > 0 ? <RowSeparator /> : null}
                    <MoveRow
                      label={entry.label}
                      icon={entry.icon}
                      hint={entry.hint}
                      checked={checked}
                      checkColor={palette.accent}
                      onPress={() => move(entry.target)}
                    />
                  </View>
                );
              })}
              {sectionIndex === 0 ? (
                <View>
                  <RowSeparator />
                  <MoveRow
                    label="Pick a date"
                    icon="calendar"
                    chevron
                    expanded={picking}
                    checked={false}
                    checkColor={palette.accent}
                    onPress={() => setPicking((open) => !open)}
                  />
                  {picking ? (
                    <View className="items-center px-3 pb-3">
                      <TaskDatePicker
                        value={pickedDate}
                        onChange={(date) => {
                          setPickedDate(date);
                          move({ kind: "date", date });
                        }}
                        onDismiss={() => setPicking(false)}
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </TaskCard>
          </Fragment>
        ))}
        {single !== undefined ? (
          <Text className="px-9 pt-4 text-[13px] text-foreground-tertiary">
            Now: {formatTaskHome(single.home, today)}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function MoveRow(props: {
  readonly label: string;
  readonly icon: "calendar" | "tray";
  readonly hint?: string;
  readonly checked: boolean;
  readonly checkColor: string;
  readonly chevron?: boolean;
  readonly expanded?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.hint ? `${props.label}, ${props.hint}` : props.label}
      accessibilityState={{ selected: props.checked, expanded: props.expanded }}
      onPress={props.onPress}
      className="min-h-[52px] flex-row items-center gap-4 px-4"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name={symbol(props.icon, "folder")}
        size={18}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <Text className="flex-1 text-[17px] text-foreground">{props.label}</Text>
      {props.hint !== undefined ? (
        <Text className="text-[15px] text-foreground-muted">{props.hint}</Text>
      ) : null}
      {props.checked ? (
        <SymbolView
          name={symbol("checkmark")}
          size={15}
          tintColor={props.checkColor}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
      {props.chevron ? (
        <SymbolView
          name={symbol(props.expanded ? "chevron.down" : "chevron.right", "keyboard_arrow_down")}
          size={13}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
