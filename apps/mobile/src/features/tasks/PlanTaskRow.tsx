import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskTime,
  isTaskOverdue,
  type TaskAgentState,
} from "@t3tools/client-runtime/state/projects";
import {
  isProposedTask,
  TASK_NOTES_MAX,
  TASK_TITLE_MAX,
  type ProjectStatus,
  type Task,
  type ThreadId,
} from "@t3tools/contracts";
import { memo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { PillButton } from "../status/ProjectStatusPanel";
import { recommendationButtonLabel } from "../status/projectStatus.logic";
import { REMINDER_TIMES, REPEAT_OPTIONS } from "./taskMenus";
import { symbol, TaskCheckbox, TaskChip, useTaskPalette, BARE_INPUT_STYLE } from "./taskUi";
import type { TaskActions } from "./useMobileTasks";

// Fork-owned. One personal task. Swipe right to select, swipe left to Move
// or Schedule; tap the title to open it in place.

export interface PlanTaskRowContext {
  readonly today: string;
  readonly actions: TaskActions;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onComplete: (task: Task) => void;
  readonly onMove: (task: Task, mode?: "schedule") => void;
  readonly onEnterSelect: (task: Task) => void;
  readonly onHandToAgent: (
    task: Task,
    kind: "coordinator" | "agent",
    project: EnvironmentProject,
  ) => void;
  readonly onOpenStatus: (project: EnvironmentProject) => void;
  readonly onAnswerStatus: (project: EnvironmentProject, status: ProjectStatus) => void;
  readonly onReplyStatus: (project: EnvironmentProject, status: ProjectStatus) => void;
  readonly onOpenThread: (project: EnvironmentProject, threadId: ThreadId) => void;
}

/** What the row says about where the task lives: time today, overdue day, repeat, period. */
export function taskRowMeta(task: Task, today: string, hidePeriod: boolean): string | null {
  if (task.recurrence !== undefined) return formatTaskRecurrence(task.recurrence);
  if (hidePeriod && task.home.kind === "period") return null;
  if (task.home.kind === "date" && task.home.date === today) {
    return task.home.reminderTime !== undefined ? formatTaskTime(task.home.reminderTime) : null;
  }
  return formatTaskHome(task.home, today);
}

const SWIPE_ACTION_WIDTH = 88;

export const PlanTaskRow = memo(function PlanTaskRow(props: {
  readonly task: Task;
  readonly state: TaskAgentState;
  readonly context: PlanTaskRowContext;
  readonly expanded: boolean;
  readonly onToggleExpanded: (taskId: string) => void;
  readonly selecting: boolean;
  readonly selected: boolean;
  readonly onToggleSelected: (taskId: string) => void;
  /** Today hides today's date; commitment lists hide their own period. */
  readonly hidePeriod?: boolean;
  /** The All tasks list puts the home at the trailing edge. */
  readonly metaPlacement?: "below" | "trailing";
}) {
  const { task, state, context, expanded, selecting, selected } = props;
  const palette = useTaskPalette();
  const swipeRef = useRef<SwipeableMethods | null>(null);
  const project = context.projects.find((p) => p.id === task.links?.projectId) ?? null;
  const completed = task.status === "completed";
  const overdue = isTaskOverdue(task, context.today);
  const trailingMeta = props.metaPlacement === "trailing";
  // The All tasks list names every home, Today included.
  const meta =
    trailingMeta && task.recurrence === undefined
      ? formatTaskHome(task.home, context.today)
      : taskRowMeta(task, context.today, props.hidePeriod === true);
  const agentActive = state.kind === "agent-working" || state.kind === "handed-off";

  const body = (
    <View
      className={cn("bg-card", selected && "bg-secondary")}
      style={{ paddingVertical: 4, paddingRight: 16 }}
    >
      <View className="flex-row items-start">
        <View className="pl-1.5">
          {selecting ? (
            <TaskCheckbox
              checked={selected}
              selecting
              label={selected ? `Deselect ${task.title}` : `Select ${task.title}`}
              onPress={() => props.onToggleSelected(task.id)}
            />
          ) : (
            <TaskCheckbox
              checked={completed}
              label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
              onPress={() =>
                completed
                  ? void context.actions.setCompleted(task, false)
                  : context.onComplete(task)
              }
            />
          )}
        </View>
        <View className="min-w-0 flex-1 pt-[9px]">
          {expanded && !selecting ? (
            <TitleInput task={task} actions={context.actions} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={task.title}
              accessibilityHint={selecting ? "Selects the task" : "Opens the task"}
              onPress={() =>
                selecting ? props.onToggleSelected(task.id) : props.onToggleExpanded(task.id)
              }
              className="min-h-[26px] flex-row items-center gap-2"
            >
              <Text
                className={cn(
                  "shrink text-[17px] font-t3-bold text-foreground",
                  completed && "font-t3 text-foreground-muted line-through",
                )}
                numberOfLines={1}
              >
                {task.title}
              </Text>
              {agentActive ? (
                <View
                  accessibilityRole="image"
                  accessibilityLabel={
                    state.kind === "agent-working"
                      ? "An agent is working on this"
                      : "Handed to an agent"
                  }
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: palette.working,
                    opacity: state.kind === "agent-working" ? 1 : 0.5,
                  }}
                />
              ) : null}
              {trailingMeta && meta !== null ? (
                <Text
                  className="ml-auto pl-2 text-[14px] text-foreground-muted"
                  style={overdue ? { color: palette.overdue } : undefined}
                  numberOfLines={1}
                >
                  {meta}
                </Text>
              ) : null}
            </Pressable>
          )}
          {!trailingMeta && meta !== null && !expanded ? (
            <Text
              className="pt-0.5 text-[14px] text-foreground-muted"
              style={overdue ? { color: palette.overdue } : undefined}
            >
              {meta}
            </Text>
          ) : null}
          {!selecting && (state.kind === "needs-you" || state.kind === "workstream-done") ? (
            <LifecycleLine task={task} state={state} project={project} context={context} />
          ) : null}
          {expanded && !selecting ? (
            <ExpandedTask
              task={task}
              state={state}
              project={project}
              context={context}
              onClose={() => props.onToggleExpanded(task.id)}
            />
          ) : (
            <View className="h-2" />
          )}
        </View>
      </View>
    </View>
  );

  if (selecting || expanded) return body;

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1.6}
      leftThreshold={SWIPE_ACTION_WIDTH * 0.6}
      rightThreshold={SWIPE_ACTION_WIDTH * 0.6}
      overshootLeft={false}
      overshootRight={false}
      onSwipeableOpen={(direction) => {
        // Opening the left (Select) side enters select mode with this row.
        if (direction === SwipeDirection.RIGHT) {
          swipeRef.current?.close();
          context.onEnterSelect(task);
        }
      }}
      renderLeftActions={() => (
        <SwipeCell
          label="Select"
          icon="checkmark.circle.fill"
          background={palette.swipeSelect}
          foreground={palette.accent}
          labelClassName="text-foreground"
          onPress={() => {
            swipeRef.current?.close();
            context.onEnterSelect(task);
          }}
        />
      )}
      renderRightActions={() => (
        <View className="flex-row">
          <SwipeCell
            label="Move"
            icon="arrow.left.arrow.right"
            background={palette.swipeMove}
            foreground="#ffffff"
            onPress={() => {
              swipeRef.current?.close();
              context.onMove(task);
            }}
          />
          <SwipeCell
            label="Schedule"
            icon="calendar"
            background={palette.swipeSchedule}
            foreground="#ffffff"
            onPress={() => {
              swipeRef.current?.close();
              context.onMove(task, "schedule");
            }}
          />
        </View>
      )}
    >
      {body}
    </ReanimatedSwipeable>
  );
});

function SwipeCell(props: {
  readonly label: string;
  readonly icon: Parameters<typeof symbol>[0];
  readonly background: string;
  readonly foreground: string;
  readonly labelClassName?: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{
        width: SWIPE_ACTION_WIDTH,
        backgroundColor: props.background,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
      }}
    >
      <SymbolView
        name={symbol(props.icon)}
        size={20}
        tintColor={props.foreground}
        type="monochrome"
      />
      <Text
        className={cn("text-[13px] font-t3-bold", props.labelClassName)}
        style={props.labelClassName ? undefined : { color: props.foreground }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function TitleInput(props: { readonly task: Task; readonly actions: TaskActions }) {
  const [value, setValue] = useState(props.task.title);
  // The title turns editable on its own tap, so the tap that opened the row
  // never lands in a freshly mounted field and raises the keyboard.
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const title = value.trim();
    if (title.length === 0 || title === props.task.title) {
      setValue(props.task.title);
      return;
    }
    void props.actions.patch(props.task, { title });
  };
  if (!editing) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Rename ${props.task.title}`}
        onPress={() => setEditing(true)}
        className="min-h-[26px] justify-center"
      >
        <Text className="text-[17px] font-t3-bold text-foreground">{value}</Text>
      </Pressable>
    );
  }
  return (
    <AppTextInput
      accessibilityLabel="Task title"
      autoFocus
      style={BARE_INPUT_STYLE}
      className="min-h-[26px] rounded-none border-0 bg-transparent p-0 text-[17px] font-t3-bold text-foreground"
      value={value}
      maxLength={TASK_TITLE_MAX}
      multiline
      submitBehavior="blurAndSubmit"
      onChangeText={setValue}
      onBlur={commit}
      onSubmitEditing={commit}
    />
  );
}

function NotesInput(props: { readonly task: Task; readonly actions: TaskActions }) {
  const [value, setValue] = useState(props.task.notes ?? "");
  return (
    <AppTextInput
      accessibilityLabel="Notes"
      style={BARE_INPUT_STYLE}
      className="min-h-0 rounded-none border-0 bg-transparent p-0 text-[15px] leading-[21px] text-foreground-muted"
      placeholder="Notes"
      value={value}
      maxLength={TASK_NOTES_MAX}
      multiline
      onChangeText={setValue}
      onBlur={() => {
        if (value.trim() !== (props.task.notes ?? "")) {
          void props.actions.patch(props.task, { notes: value });
        }
      }}
    />
  );
}

function LifecycleLine(props: {
  readonly task: Task;
  readonly state: Extract<TaskAgentState, { kind: "needs-you" | "workstream-done" }>;
  readonly project: EnvironmentProject | null;
  readonly context: PlanTaskRowContext;
}) {
  const { task, state, project, context } = props;
  const palette = useTaskPalette();
  if (state.kind === "needs-you") {
    return (
      <View className="min-h-9 flex-row items-center gap-2">
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.needsYou }} />
        <Text className="text-[14px] font-t3-medium" style={{ color: palette.warningText }}>
          Needs you
        </Text>
        <Text className="min-w-0 flex-1 text-[14px] text-foreground-muted" numberOfLines={1}>
          {state.status.decision?.question ?? state.status.summary}
        </Text>
        {project !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Answer ${state.status.title}`}
            onPress={() => context.onOpenStatus(project)}
            className="min-h-9 justify-center px-1"
          >
            <Text className="text-[14px] font-t3-bold" style={{ color: palette.warningText }}>
              Answer
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View className="min-h-9 flex-row flex-wrap items-center gap-x-3">
      <Text className="text-[15px]" style={{ color: palette.doneText }} numberOfLines={1}>
        {state.status.title} is done
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Complete ${task.title}`}
        onPress={() => context.onComplete(task)}
        className="min-h-9 justify-center"
      >
        <Text className="text-[15px] font-t3-bold" style={{ color: palette.doneText }}>
          Complete
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Not yet, keep ${task.title} open`}
        onPress={() =>
          void context.actions.patch(task, {
            completionPromptDismissedAt: new Date().toISOString(),
          })
        }
        className="min-h-9 justify-center"
      >
        <Text className="text-[15px] text-foreground-muted">Not yet</Text>
      </Pressable>
    </View>
  );
}

function ExpandedTask(props: {
  readonly task: Task;
  readonly state: TaskAgentState;
  readonly project: EnvironmentProject | null;
  readonly context: PlanTaskRowContext;
  readonly onClose: () => void;
}) {
  const { task, state, project, context } = props;
  const palette = useTaskPalette();
  const reminder = task.home.kind === "date" ? task.home.reminderTime : undefined;
  const statuses = (project?.assistant?.statuses ?? []).filter((s) => s.dismissedAt === undefined);
  const status =
    task.links?.statusId === undefined
      ? undefined
      : project?.assistant?.statuses?.find((s) => s.id === task.links!.statusId);
  const assistantProjects = context.projects.filter((p) => p.assistant != null);
  const canHandOff = project !== null && project.assistant != null && !isProposedTask(task);

  return (
    <View className="gap-3 pb-3 pt-1">
      <NotesInput key={task.notes ?? ""} task={task} actions={context.actions} />
      <View className="flex-row flex-wrap gap-2">
        <TaskChip
          active
          icon={symbol("calendar", "folder")}
          label={formatTaskHome(task.home, context.today)}
          accessibilityLabel={`Move task, now ${formatTaskHome(task.home, context.today)}`}
          onPress={() => context.onMove(task)}
        />
        {task.home.kind === "date" ? (
          <ControlPillMenu
            actions={[
              ...REMINDER_TIMES.map((time) => ({
                id: time,
                title: formatTaskTime(time),
                state: reminder === time ? ("on" as const) : undefined,
              })),
              ...(reminder !== undefined ? [{ id: "none", title: "No reminder" }] : []),
            ]}
            onPressAction={({ nativeEvent }) => {
              if (task.home.kind !== "date") return;
              const { reminderTime: _drop, ...rest } = task.home;
              void context.actions.move(
                task,
                nativeEvent.event === "none" ? rest : { ...rest, reminderTime: nativeEvent.event },
              );
            }}
          >
            <TaskChip
              active={reminder !== undefined}
              icon={symbol("bell", "check")}
              label={reminder !== undefined ? formatTaskTime(reminder) : "Remind"}
            />
          </ControlPillMenu>
        ) : null}
        {task.home.kind === "date" ? (
          <ControlPillMenu
            actions={REPEAT_OPTIONS.map((option) => ({ id: option.label, title: option.label }))}
            onPressAction={({ nativeEvent }) =>
              void context.actions.patch(task, {
                recurrence:
                  REPEAT_OPTIONS.find((option) => option.label === nativeEvent.event)?.value ??
                  null,
              })
            }
          >
            <TaskChip
              active={task.recurrence !== undefined}
              icon={symbol("repeat", "check")}
              label={
                task.recurrence !== undefined ? formatTaskRecurrence(task.recurrence) : "Repeat"
              }
            />
          </ControlPillMenu>
        ) : null}
        <ControlPillMenu
          actions={[
            ...assistantProjects.map((candidate) => ({ id: candidate.id, title: candidate.title })),
            ...(project !== null ? [{ id: "none", title: "No project" }] : []),
          ]}
          onPressAction={({ nativeEvent }) =>
            void context.actions.patch(task, {
              links:
                nativeEvent.event === "none"
                  ? null
                  : { projectId: nativeEvent.event as NonNullable<Task["links"]>["projectId"] },
            })
          }
        >
          <TaskChip
            active={project !== null}
            icon={symbol("folder", "folder")}
            label={project?.title ?? "Project"}
          />
        </ControlPillMenu>
        {project !== null && statuses.length > 0 ? (
          <ControlPillMenu
            actions={[
              ...statuses.map((candidate) => ({ id: candidate.id, title: candidate.title })),
              ...(status !== undefined ? [{ id: "none", title: "Unlink workstream" }] : []),
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "none") {
                const { statusId: _drop, ...rest } = task.links ?? {};
                void context.actions.patch(task, { links: rest });
                return;
              }
              void context.actions.patch(task, {
                links: {
                  ...task.links,
                  projectId: project.id,
                  statusId: nativeEvent.event as ProjectStatus["id"],
                },
              });
            }}
          >
            <TaskChip
              active={status !== undefined}
              icon={status === undefined ? symbol("link", "check") : undefined}
              leading={
                status !== undefined ? (
                  <View
                    style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.done }}
                  />
                ) : undefined
              }
              label={status?.title ?? "Link"}
            />
          </ControlPillMenu>
        ) : null}
        {task.handoff !== undefined && project !== null ? (
          <TaskChip
            active
            icon={symbol("bubble.left", "chat_bubble")}
            label={
              task.handoff.kind === "coordinator" ? `${project.title} coordinator` : "Agent thread"
            }
            onPress={() => context.onOpenThread(project, task.handoff!.threadId)}
          />
        ) : null}
      </View>
      {state.kind === "needs-you" && project !== null ? (
        <StatusInlineCard
          status={state.status}
          onAnswer={() => context.onAnswerStatus(project, state.status)}
          onReply={() => context.onReplyStatus(project, state.status)}
          onOpen={() => context.onOpenStatus(project)}
        />
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">
        {canHandOff ? (
          <ControlPillMenu
            actions={[
              { id: "coordinator", title: `Ask ${project.title} coordinator` },
              { id: "agent", title: "Start an agent" },
            ]}
            onPressAction={({ nativeEvent }) =>
              context.onHandToAgent(
                task,
                nativeEvent.event === "agent" ? "agent" : "coordinator",
                project,
              )
            }
          >
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel="Hand to agent"
              style={{
                minHeight: 44,
                paddingHorizontal: 18,
                borderRadius: 22,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                backgroundColor: palette.accent,
              }}
            >
              <SymbolView
                name={symbol("cpu", "build")}
                size={15}
                tintColor={palette.accentForeground}
                type="monochrome"
              />
              <Text
                className="text-[15px] font-t3-medium"
                style={{ color: palette.accentForeground }}
              >
                Hand to agent
              </Text>
            </View>
          </ControlPillMenu>
        ) : null}
        <PillButton label="Done" tone="secondary" onPress={props.onClose} />
        <View className="flex-1" />
        <ControlPillMenu
          actions={[
            ...(task.handoff !== undefined ? [{ id: "unlink", title: "Unlink agent thread" }] : []),
            { id: "cancel", title: "Cancel task" },
            { id: "delete", title: "Delete task", attributes: { destructive: true } },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "unlink") void context.actions.handOff(task, null);
            if (nativeEvent.event === "cancel") {
              void context.actions.patch(
                task,
                { status: "cancelled" },
                `Could not cancel ${task.title}`,
              );
            }
            if (nativeEvent.event === "delete") void context.actions.delete(task);
          }}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={`More actions for ${task.title}`}
            className="size-11 items-center justify-center"
          >
            <SymbolView
              name={symbol("ellipsis", "more_vert")}
              size={17}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </View>
        </ControlPillMenu>
      </View>
    </View>
  );
}

/** A linked workstream's open question, answerable from the task (iPad detail). */
function StatusInlineCard(props: {
  readonly status: ProjectStatus;
  readonly onAnswer: () => void;
  readonly onReply: () => void;
  readonly onOpen: () => void;
}) {
  const { status } = props;
  const palette = useTaskPalette();
  const decision = status.decision;
  return (
    <View className="gap-2 rounded-xl bg-secondary p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open Status for ${status.title}`}
        onPress={props.onOpen}
        className="flex-row items-center gap-2"
      >
        <View
          style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: palette.needsYou }}
        />
        <Text className="flex-1 text-[16px] font-t3-bold text-foreground" numberOfLines={1}>
          {status.title}
        </Text>
        <SymbolView
          name={symbol("chevron.right", "keyboard_arrow_down")}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
      <Text className="pl-[15px] text-[14px] text-foreground-muted" numberOfLines={1}>
        {status.summary}
      </Text>
      {decision !== undefined ? (
        <>
          <Text className="pl-[15px] text-[16px] text-foreground">{decision.question}</Text>
          <View className="flex-row flex-wrap items-center gap-2 pl-[15px]">
            <PillButton
              label={recommendationButtonLabel(decision)}
              tone="primary"
              icon="checkmark"
              onPress={props.onAnswer}
            />
            <PillButton label="Reply" tone="secondary" onPress={props.onReply} />
            <Text className="text-[13px] text-foreground-muted">Recommended</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}
