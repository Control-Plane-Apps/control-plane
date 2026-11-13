import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { tasksForStatus } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isAutoAcceptArmed,
  PROJECT_STATUS_QUESTION_MAX,
  type ProjectStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, View, type ScrollViewProps } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useMobileTasks } from "../tasks/useMobileTasks";
import {
  RowSeparator,
  SectionLabel,
  TaskCard,
  symbol,
  UndoBanner,
  useTaskPalette,
  useUndoNotice,
} from "../tasks/taskUi";
import {
  ASK_FOR_UPDATE_PROMPT,
  STATUS_GROUP_LABEL,
  canToggleAutoAccept,
  describeDecisionDeadline,
  describeLiveAgent,
  formatDeadlineShort,
  formatStatusAge,
  groupProjectStatuses,
  isRecommendationPending,
  recommendationButtonLabel,
  recommendationKey,
  recommendationReplyText,
  showsFullRecommendation,
  statusReplyPlacement,
  statusReplyTagFor,
  type StatusGroup,
  type StatusReplyTag,
} from "./projectStatus.logic";
import { sendThreadMessage } from "./statusReplyStore";

// Fork-owned. The coordinator's Status board on phone (full screen) and iPad
// (beside the thread): Needs you, In progress, Queued, Done, one tap to answer.

const MINUTE_MS = 60_000;

export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(interval);
  }, []);
  return now;
}

export interface ProjectStatusPanelProps {
  readonly project: EnvironmentProject;
  /** Puts a "Re: <title>" chip on the coordinator composer, then shows it. */
  readonly onReply: (tag: StatusReplyTag, draft?: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly contentInsetAdjustmentBehavior?: ScrollViewProps["contentInsetAdjustmentBehavior"];
  readonly header?: ReactNode;
}

export function ProjectStatusPanel(props: ProjectStatusPanelProps) {
  const { project } = props;
  const palette = useTaskPalette();
  const now = useMinuteNow();
  const statuses = project.assistant?.statuses ?? [];
  const groups = useMemo(() => groupProjectStatuses(statuses), [statuses]);
  const hiddenCount = statuses.filter((status) => status.dismissedAt !== undefined).length;
  const coordinatorThreadId = project.assistant?.coordinatorThreadId ?? null;
  const threads = useThreadShells();
  const threadsById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const { tasks } = useMobileTasks();
  const outbox = useThreadOutboxMessages();
  const queuedTexts = useMemo(
    () =>
      coordinatorThreadId === null
        ? []
        : (outbox[scopedThreadKey(project.environmentId, coordinatorThreadId)] ?? []).map(
            (message) => message.text,
          ),
    [coordinatorThreadId, outbox, project.environmentId],
  );
  // One-tap answers sent from here, until the server marks the decision answered.
  const [sentKeys, setSentKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const undo = useUndoNotice();
  const automate = useAtomCommand(projectEnvironment.automateStatus, { reportFailure: false });
  const dismiss = useAtomCommand(projectEnvironment.dismissStatus, { reportFailure: false });

  const mark = (key: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const reportFailure = (title: string, result: unknown, fallback: string) => {
    if (isAtomCommandInterrupted(result as never)) return;
    const error = squashAtomCommandFailure(result as never);
    Alert.alert(title, error instanceof Error ? error.message : fallback);
  };

  const goWithRecommendation = async (status: ProjectStatus) => {
    const decision = status.decision;
    if (decision === undefined || coordinatorThreadId === null) return;
    const key = recommendationKey(status, decision);
    setSentKeys((current) => new Set(current).add(key));
    try {
      await sendThreadMessage({
        environmentId: project.environmentId,
        threadId: coordinatorThreadId,
        text: recommendationReplyText(status, decision),
      });
    } catch {
      setSentKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      Alert.alert(`Could not answer ${status.title}`, "Try again in a moment.");
    }
  };

  const setAutoAccept = async (status: ProjectStatus, enabled: boolean) => {
    const decision = status.decision;
    if (decision === undefined) return;
    const key = `automate:${status.id}`;
    mark(key, true);
    const result = await automate({
      environmentId: project.environmentId,
      input: { projectId: project.id, statusId: status.id, openedAt: decision.openedAt, enabled },
    });
    mark(key, false);
    if (result._tag !== "Success") {
      reportFailure(
        `Could not change ${status.title}`,
        result,
        "The decision changed since you saw it. Review it and try again.",
      );
    }
  };

  const setDismissed = async (status: ProjectStatus, dismissed: boolean): Promise<boolean> => {
    const key = `dismiss:${status.id}`;
    mark(key, true);
    const result = await dismiss({
      environmentId: project.environmentId,
      input: { projectId: project.id, statusId: status.id, updatedAt: status.updatedAt, dismissed },
    });
    mark(key, false);
    if (result._tag === "Success") return true;
    reportFailure(
      dismissed ? `Could not check off ${status.title}` : `Could not restore ${status.title}`,
      result,
      "The workstream changed since you saw it. Review it and try again.",
    );
    return false;
  };

  const checkOff = async (status: ProjectStatus) => {
    if (!(await setDismissed(status, true))) return;
    undo.show(`Checked off ${status.title}`, () => void setDismissed(status, false));
  };

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <View className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior={props.contentInsetAdjustmentBehavior ?? "never"}
        contentContainerStyle={{ paddingBottom: 96 }}
      >
        {props.header}
        {groups.length === 0 ? (
          <View className="gap-2 px-6 pt-24">
            {hiddenCount > 0 ? (
              <Text className="text-center text-[15px] text-foreground-muted">
                Nothing open. You checked off every finished workstream.
              </Text>
            ) : (
              <>
                <Text className="text-center text-[15px] text-foreground-muted">
                  No workstreams yet.
                </Text>
                <Text className="text-center text-[13px] text-foreground-tertiary">
                  The coordinator keeps one line per workstream here as agents report in, and flags
                  anything that needs your call.
                </Text>
              </>
            )}
          </View>
        ) : (
          groups.map(({ group, statuses: members }) => (
            <View key={group}>
              <SectionLabel
                tone={group === "needs-you" ? "warning" : "muted"}
                trailing={
                  <Text
                    className="text-[13px] tabular-nums"
                    style={{ color: group === "needs-you" ? palette.warningText : undefined }}
                  >
                    <Text className="text-foreground-tertiary">{members.length}</Text>
                  </Text>
                }
              >
                {STATUS_GROUP_LABEL[group]}
              </SectionLabel>
              <TaskCard>
                {members.map((status, index) => (
                  <View key={status.id}>
                    {index > 0 ? <RowSeparator inset={32} /> : null}
                    <StatusRow
                      status={status}
                      group={group}
                      now={now}
                      expanded={expanded.has(status.id)}
                      onToggle={() => toggle(status.id)}
                      linkedTasks={tasksForStatus(tasks, project.id, status.id).map((t) => t.title)}
                      sending={isRecommendationPending({ status, queuedTexts, sentKeys })}
                      automating={busy.has(`automate:${status.id}`)}
                      dismissing={busy.has(`dismiss:${status.id}`)}
                      liveAgents={(status.agents ?? []).flatMap((threadId) => {
                        const live = describeLiveAgent(threadsById.get(threadId) ?? null);
                        return live === null ? [] : [{ threadId, ...live }];
                      })}
                      onGoWithRecommendation={() => void goWithRecommendation(status)}
                      onReply={(withQuestion) =>
                        props.onReply(statusReplyTagFor(status, withQuestion))
                      }
                      onAskForUpdate={() =>
                        props.onReply(statusReplyTagFor(status, false), ASK_FOR_UPDATE_PROMPT)
                      }
                      onSetAutoAccept={(enabled) => void setAutoAccept(status, enabled)}
                      onCheckOff={() => void checkOff(status)}
                      onOpenThread={props.onOpenThread}
                    />
                  </View>
                ))}
              </TaskCard>
            </View>
          ))
        )}
      </ScrollView>
      <UndoBanner notice={undo.notice} onDismiss={undo.dismiss} />
    </View>
  );
}

function dotColor(group: StatusGroup, palette: ReturnType<typeof useTaskPalette>): string {
  switch (group) {
    case "needs-you":
      return palette.needsYou;
    case "in-progress":
      return palette.working;
    case "queued":
      return palette.queued;
    case "done":
      return palette.done;
  }
}

function StatusRow(props: {
  readonly status: ProjectStatus;
  readonly group: StatusGroup;
  readonly now: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly linkedTasks: ReadonlyArray<string>;
  readonly sending: boolean;
  readonly automating: boolean;
  readonly dismissing: boolean;
  readonly liveAgents: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly label: string;
    readonly tone: "working" | "attention" | "idle";
  }>;
  readonly onGoWithRecommendation: () => void;
  readonly onReply: (withQuestion: boolean) => void;
  readonly onAskForUpdate: () => void;
  readonly onSetAutoAccept: (enabled: boolean) => void;
  readonly onCheckOff: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { status, group, now, expanded } = props;
  const palette = useTaskPalette();
  const decision = status.decision;
  const placement = statusReplyPlacement(status, group);
  const asking = placement === "question" && decision !== undefined;
  const answered = placement === "answered" ? decision : undefined;
  const headerReply = placement === "header";
  const deadline = decision === undefined ? null : describeDecisionDeadline(decision, now);
  const agentColor = (tone: "working" | "attention" | "idle") =>
    tone === "working" ? palette.working : tone === "attention" ? palette.needsYou : palette.queued;

  return (
    <View className="pb-1">
      <View className="flex-row items-start">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${status.title}. ${status.summary}`}
          accessibilityHint={expanded ? "Collapses the details" : "Shows the details"}
          accessibilityState={{ expanded }}
          onPress={props.onToggle}
          className="min-h-11 flex-1 py-2.5 pl-4 pr-2"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <View className="flex-row items-center gap-2.5">
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor: dotColor(group, palette),
              }}
            />
            <Text
              className="flex-1 text-[17px] font-t3-bold text-foreground"
              numberOfLines={expanded ? undefined : 1}
            >
              {status.title}
            </Text>
            <SymbolView
              name={symbol(
                expanded ? "chevron.down" : "chevron.right",
                expanded ? "keyboard_arrow_down" : "keyboard_arrow_up",
              )}
              size={13}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
              weight="semibold"
            />
          </View>
          <Text
            className="pl-[17px] pt-0.5 text-[15px] text-foreground-muted"
            numberOfLines={expanded ? undefined : 1}
          >
            {status.summary}
          </Text>
          {props.linkedTasks.map((title) => (
            <View key={title} className="flex-row items-center gap-1.5 pl-[17px] pt-1">
              <SymbolView
                name={symbol("checklist")}
                size={11}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
              <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
                {title}
              </Text>
            </View>
          ))}
        </Pressable>
        {headerReply || group === "done" ? (
          <View className="flex-row items-center pr-1 pt-0.5">
            {headerReply ? (
              <IconButton
                label={`Reply to ${status.title}`}
                icon="arrowshape.turn.up.left"
                onPress={() => props.onReply(false)}
              />
            ) : null}
            {group === "done" ? (
              <IconButton
                label={`Check off ${status.title}`}
                icon="checkmark.circle"
                disabled={props.dismissing}
                onPress={props.onCheckOff}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {expanded ? (
        <View className="gap-2 pb-2 pl-[33px] pr-4">
          {status.detail !== undefined ? (
            <Text className="text-[15px] text-foreground-muted">{status.detail}</Text>
          ) : null}
          {decision?.why !== undefined ? (
            <Text className="text-[15px] text-foreground-muted">Why: {decision.why}</Text>
          ) : null}
          {decision !== undefined && showsFullRecommendation(decision) ? (
            <Text className="text-[15px] text-foreground-muted">
              Recommended: {decision.recommendation}
            </Text>
          ) : null}
          {props.liveAgents.map((agent) => (
            <Pressable
              key={agent.threadId}
              accessibilityRole="link"
              accessibilityLabel={`Open ${agent.label}`}
              onPress={() => props.onOpenThread(agent.threadId)}
              className="min-h-8 flex-row items-center gap-1.5"
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: agentColor(agent.tone),
                }}
              />
              <Text
                className="text-[14px]"
                style={{ color: agentColor(agent.tone) }}
                numberOfLines={1}
              >
                {agent.label}
              </Text>
            </Pressable>
          ))}
          <Text className="text-[14px] text-foreground-muted">
            · updated {formatStatusAge(status.updatedAt, now)}
            {deadline !== null ? (
              <Text
                style={{
                  color: deadline.tone === "handled" ? undefined : palette.overdue,
                }}
              >
                {"  · "}
                {deadline.text}
              </Text>
            ) : null}
          </Text>
          {decision?.deadline !== undefined && canToggleAutoAccept(decision, now) ? (
            <View className="min-h-11 flex-row items-center gap-3">
              <Text className="flex-1 text-[15px] text-foreground">
                Go with the recommendation if I don't reply by{" "}
                {formatDeadlineShort(decision.deadline, now)}
              </Text>
              <ThemedSwitch
                accessibilityLabel="Go with the recommendation at the deadline"
                value={isAutoAcceptArmed(decision)}
                disabled={props.automating}
                onValueChange={props.onSetAutoAccept}
              />
            </View>
          ) : null}
          {group !== "done" ? (
            <View className="flex-row">
              <PillButton label="Ask for update" tone="secondary" onPress={props.onAskForUpdate} />
            </View>
          ) : null}
        </View>
      ) : null}

      {asking ? (
        <View className="gap-2 pb-2 pl-[33px] pr-4 pt-1">
          <Text
            className="text-[17px] text-foreground"
            numberOfLines={
              !expanded && decision.question.length > PROJECT_STATUS_QUESTION_MAX ? 2 : undefined
            }
          >
            {decision.question}
          </Text>
          <View className="flex-row flex-wrap items-center gap-2">
            <PillButton
              label={props.sending ? "Sending..." : recommendationButtonLabel(decision)}
              tone="primary"
              icon="checkmark"
              disabled={props.sending}
              accessibilityLabel={`${recommendationButtonLabel(decision)}, recommended answer to ${status.title}`}
              onPress={props.onGoWithRecommendation}
            />
            <PillButton
              label="Reply"
              tone="secondary"
              accessibilityLabel={`Reply to ${status.title}`}
              onPress={() => props.onReply(true)}
            />
          </View>
          <Text className="text-[13px] text-foreground-muted">Recommended</Text>
        </View>
      ) : answered !== undefined ? (
        <View className="gap-2 pb-2 pl-[33px] pr-4 pt-1">
          <Text className="text-[17px] text-foreground-muted">{answered.question}</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className={cn("flex-1 text-[14px] text-foreground-muted")}>
              You replied {formatStatusAge(answered.answeredAt!, now)}. Waiting on the coordinator.
            </Text>
            <PillButton
              label="Reply"
              tone="secondary"
              accessibilityLabel={`Reply to ${status.title}`}
              onPress={() => props.onReply(true)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function IconButton(props: {
  readonly label: string;
  readonly icon: Parameters<typeof symbol>[0];
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="size-11 items-center justify-center"
      style={({ pressed }) => ({ opacity: props.disabled ? 0.4 : pressed ? 0.5 : 1 })}
    >
      <SymbolView
        name={symbol(props.icon, props.icon === "checkmark.circle" ? "check" : "edit")}
        size={17}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
}

export function PillButton(props: {
  readonly label: string;
  readonly tone: "primary" | "secondary";
  readonly icon?: Parameters<typeof symbol>[0];
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
}) {
  const palette = useTaskPalette();
  const primary = props.tone === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        opacity: props.disabled ? 0.55 : pressed ? 0.75 : 1,
        minHeight: 44,
        paddingHorizontal: 18,
        borderRadius: 22,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: primary ? palette.accent : palette.chip,
        maxWidth: "100%",
      })}
    >
      {props.icon ? (
        <SymbolView
          name={symbol(props.icon)}
          size={13}
          tintColor={primary ? palette.accentForeground : undefined}
          tintColorClassName={primary ? undefined : "accent-foreground"}
          type="monochrome"
          weight="bold"
        />
      ) : null}
      <Text
        className={cn("text-[15px] font-t3-medium", !primary && "text-foreground")}
        style={primary ? { color: palette.accentForeground } : undefined}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
