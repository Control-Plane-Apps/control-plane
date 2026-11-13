import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskTime,
  homeForMove,
  parseQuickAdd,
} from "@t3tools/client-runtime/state/projects";
import {
  taskPeriodFor,
  TASK_TITLE_MAX,
  type ProjectId,
  type TaskHome,
  type TaskHorizon,
  type TaskRecurrence,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppTextInput } from "../../components/AppText";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { moveSections } from "./TaskMoveSheet";
import { REMINDER_TIMES, REPEAT_OPTIONS } from "./taskMenus";
import { symbol, TaskCheckbox, TaskChip, useTaskPalette, BARE_INPUT_STYLE } from "./taskUi";
import { useMobileTaskStore, useTaskToday } from "./useMobileTasks";

// Fork-owned. Quick add: type a title with an optional when-phrase
// ("tomorrow 9am"); the chips show what it parsed and can change it.

type TaskQuickAddParams = {
  /** Where a task lands when the title names no day. */
  readonly horizon?: "today" | TaskHorizon | "backlog";
  readonly projectId?: string;
};

export function defaultQuickAddHome(
  horizon: TaskQuickAddParams["horizon"],
  today: string,
): TaskHome {
  switch (horizon) {
    case "week":
    case "month":
    case "year":
      return { kind: "period", horizon, ...taskPeriodFor(horizon, today) };
    case "backlog":
      return { kind: "backlog", horizon: null };
    default:
      return { kind: "date", date: today };
  }
}

export function TaskQuickAddSheet({ route }: StaticScreenProps<TaskQuickAddParams | undefined>) {
  const navigation = useNavigation();
  const palette = useTaskPalette();
  const today = useTaskToday();
  const { actions, projects } = useMobileTaskStore();
  const [text, setText] = useState("");
  const [homeOverride, setHomeOverride] = useState<TaskHome | null>(null);
  const [reminderOverride, setReminderOverride] = useState<string | null | undefined>(undefined);
  const [projectId, setProjectId] = useState<string | null>(route.params?.projectId ?? null);
  const [recurrence, setRecurrence] = useState<TaskRecurrence | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => parseQuickAdd(text, today), [text, today]);
  const baseHome = homeOverride ?? parsed.home ?? defaultQuickAddHome(route.params?.horizon, today);
  const home: TaskHome =
    baseHome.kind !== "date" || reminderOverride === undefined
      ? baseHome
      : reminderOverride === null
        ? { kind: "date", date: baseHome.date }
        : { ...baseHome, reminderTime: reminderOverride };
  const reminder = home.kind === "date" ? home.reminderTime : undefined;
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const title = parsed.title.trim();
  const canAdd = title.length > 0 && !busy && actions.available;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    const created = await actions.create({
      title,
      home,
      ...(recurrence !== null && home.kind === "date" ? { recurrence } : {}),
      ...(project !== null ? { links: { projectId: project.id as ProjectId } } : {}),
    });
    setBusy(false);
    if (created !== null) navigation.goBack();
  };

  const dayActions = moveSections(today).flatMap((section) =>
    section.entries.map((entry) => ({ id: entry.label, title: entry.label, target: entry.target })),
  );

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-sheet-solid">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 16 }}>
        <View className="flex-row items-center gap-1 pl-2 pr-4 pt-4">
          <TaskCheckbox checked={false} label="New task" disabled onPress={() => undefined} />
          <AppTextInput
            accessibilityLabel="Task title"
            style={{ ...BARE_INPUT_STYLE, minHeight: 44 }}
            autoFocus
            className="min-h-11 flex-1 rounded-none border-0 bg-transparent px-1 py-2 text-[18px] text-foreground"
            maxLength={TASK_TITLE_MAX}
            onChangeText={setText}
            onSubmitEditing={() => void add()}
            placeholder="Task title"
            returnKeyType="done"
            submitBehavior="submit"
            value={text}
          />
        </View>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingLeft: 56, paddingRight: 16, paddingTop: 10 }}
        >
          <ControlPillMenu
            actions={dayActions.map((action) => ({ id: action.id, title: action.title }))}
            onPressAction={({ nativeEvent }) => {
              const entry = dayActions.find((action) => action.id === nativeEvent.event);
              if (entry !== undefined) setHomeOverride(homeForMove(entry.target, home, today));
            }}
          >
            <TaskChip
              active
              icon={symbol("calendar", "folder")}
              label={formatTaskHome(home, today)}
              accessibilityLabel={`When, ${formatTaskHome(home, today)}`}
            />
          </ControlPillMenu>
          {home.kind === "date" ? (
            <ControlPillMenu
              actions={[
                ...REMINDER_TIMES.map((time) => ({ id: time, title: formatTaskTime(time) })),
                ...(reminder !== undefined ? [{ id: "none", title: "No reminder" }] : []),
              ]}
              onPressAction={({ nativeEvent }) =>
                setReminderOverride(nativeEvent.event === "none" ? null : nativeEvent.event)
              }
            >
              <TaskChip
                active={reminder !== undefined}
                icon={symbol("bell", "check")}
                label={reminder !== undefined ? formatTaskTime(reminder) : "Remind"}
              />
            </ControlPillMenu>
          ) : null}
          <ControlPillMenu
            actions={[
              ...projects
                .filter((candidate) => candidate.assistant != null)
                .map((candidate) => ({ id: candidate.id, title: candidate.title })),
              ...(project !== null ? [{ id: "none", title: "No project" }] : []),
            ]}
            onPressAction={({ nativeEvent }) =>
              setProjectId(nativeEvent.event === "none" ? null : nativeEvent.event)
            }
          >
            <TaskChip
              active={project !== null}
              icon={symbol("folder", "folder")}
              label={project?.title ?? "Project"}
            />
          </ControlPillMenu>
          {home.kind === "date" ? (
            <ControlPillMenu
              actions={REPEAT_OPTIONS.map((option) => ({ id: option.label, title: option.label }))}
              onPressAction={({ nativeEvent }) =>
                setRecurrence(
                  REPEAT_OPTIONS.find((option) => option.label === nativeEvent.event)?.value ??
                    null,
                )
              }
            >
              <TaskChip
                active={recurrence !== null}
                icon={symbol("repeat", "check")}
                label={recurrence !== null ? formatTaskRecurrence(recurrence) : "Repeat"}
              />
            </ControlPillMenu>
          ) : null}
        </ScrollView>
        <View className="flex-row justify-end px-4 pt-4">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add task"
            accessibilityState={{ disabled: !canAdd }}
            disabled={!canAdd}
            onPress={() => void add()}
            style={({ pressed }) => ({
              opacity: !canAdd ? 0.45 : pressed ? 0.75 : 1,
              minHeight: 48,
              paddingHorizontal: 20,
              borderRadius: 24,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: palette.accent,
            })}
          >
            <SymbolView
              name={symbol("arrow.up", "check")}
              size={14}
              tintColor={palette.accentForeground}
              type="monochrome"
              weight="bold"
            />
            <Text
              className="text-[17px] font-t3-medium"
              style={{ color: palette.accentForeground }}
            >
              Add
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
