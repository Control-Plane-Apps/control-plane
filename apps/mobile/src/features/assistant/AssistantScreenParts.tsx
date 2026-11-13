import type {
  AssistantAskCard,
  AssistantAskTargetView,
} from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectStatus } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ThreadStatusDot } from "../threads/thread-status-dot";
import { NEEDS_YOU_DOT_COLOR, WORKING_DOT_COLOR } from "./AssistantHomeRow";
import { briefTimeLabel, needsYouPillText, type AssistantBrief } from "./assistantScreen.logic";
import { AssistantSectionHeader, NeedsYouList } from "./NeedsYouList";
import type { NeedsYouActions, NeedsYouItem } from "./useNeedsYouActions";

// Fork-owned. The pieces of the iPhone Assistant screen around its
// conversation: the brief, Needs you and Working on above it, the ask cards
// inside it, and the Needs-you pill above the composer.

/** Needs you shows this many cards before "See all". */
const NEEDS_YOU_PREVIEW_COUNT = 2;

function BriefCard(props: { readonly brief: AssistantBrief }) {
  const [expanded, setExpanded] = useState(false);
  const time = briefTimeLabel(props.brief.createdAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      className="mt-1 mb-3.5 min-h-[52px] flex-row items-center gap-2.5 rounded-xl bg-card py-2 pr-2.5 pl-3.5"
      onPress={() => setExpanded((value) => !value)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-[13px] text-foreground-muted">
          {time.length > 0 ? `Brief · ${time}` : "Brief"}
        </Text>
        <Text className="text-[15px] text-foreground" numberOfLines={expanded ? undefined : 1}>
          {expanded ? props.brief.text : props.brief.firstLine}
        </Text>
      </View>
      <SymbolView
        name={expanded ? "chevron.up" : "chevron.right"}
        size={14}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

function WorkingOnList(props: { readonly statuses: ReadonlyArray<ProjectStatus> }) {
  return (
    <View className="overflow-hidden rounded-xl bg-card">
      {props.statuses.map((status, index) => (
        <View key={status.id} className="min-h-[52px] flex-row items-center gap-3 px-4 py-1.5">
          {index === 0 ? null : (
            <View className="absolute top-0 right-0 left-9 h-px bg-border" pointerEvents="none" />
          )}
          <View
            className="rounded-full"
            style={{ width: 8, height: 8, backgroundColor: WORKING_DOT_COLOR ?? undefined }}
          />
          <View className="min-w-0 flex-1">
            <Text className="text-[15px] font-t3-semibold text-foreground" numberOfLines={1}>
              {status.title}
            </Text>
            <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
              {status.summary}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Above the conversation: the morning brief, what needs the user across every
 * Project, and what the Assistant itself is working on. Renders nothing when
 * all three are empty.
 */
export function AssistantOverview(props: {
  readonly brief: AssistantBrief | null;
  readonly needsYou: ReadonlyArray<NeedsYouItem>;
  readonly sentKeys: ReadonlySet<string>;
  readonly workingOn: ReadonlyArray<ProjectStatus>;
  readonly actions: NeedsYouActions;
  readonly onSeeAllNeedsYou: () => void;
}) {
  if (props.brief === null && props.needsYou.length === 0 && props.workingOn.length === 0) {
    return null;
  }
  const preview = props.needsYou.slice(0, NEEDS_YOU_PREVIEW_COUNT);
  return (
    <View className="pb-4">
      {props.brief !== null ? <BriefCard brief={props.brief} /> : null}
      {props.needsYou.length > 0 ? (
        <View>
          <AssistantSectionHeader
            label="Needs you"
            count={props.needsYou.length}
            tone="warning"
            action={{ label: "See all", onPress: props.onSeeAllNeedsYou }}
          />
          <NeedsYouList items={preview} sentKeys={props.sentKeys} actions={props.actions} />
        </View>
      ) : null}
      {props.workingOn.length > 0 ? (
        <View className={props.needsYou.length > 0 ? "mt-[18px]" : undefined}>
          <AssistantSectionHeader label="Working on" count={props.workingOn.length} tone="muted" />
          <WorkingOnList statuses={props.workingOn} />
        </View>
      ) : null}
    </View>
  );
}

function AskTargetIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly target: AssistantAskTargetView;
  readonly projectsById: ReadonlyMap<string, EnvironmentProject>;
  readonly size: number;
}) {
  const project = props.projectsById.get(props.target.projectId);
  return (
    <ProjectFavicon
      environmentId={props.environmentId}
      faviconPath={project?.faviconPath ?? null}
      fallback="letter"
      projectIcon={project?.projectIcon ?? null}
      projectTitle={props.target.title}
      size={props.size}
      workspaceRoot={project?.workspaceRoot ?? null}
    />
  );
}

/**
 * The asks the Assistant made in one reply: a row per coordinator it asked,
 * Answered or Waiting, then a card per answer that came back.
 */
export function AssistantAskCards(props: {
  readonly environmentId: EnvironmentId;
  readonly cards: ReadonlyArray<AssistantAskCard>;
  readonly projectsById: ReadonlyMap<string, EnvironmentProject>;
}) {
  return (
    <View className="pb-2">
      {props.cards.map((card) => (
        <View key={card.askId}>
          <View className="mt-2.5 overflow-hidden rounded-xl bg-card">
            {card.targets.map((target, index) => (
              <View
                key={target.coordinatorThreadId}
                accessibilityLabel={`Asked ${target.title}: ${card.question}. ${
                  target.answer !== null ? "Answered" : "Waiting"
                }`}
                accessible
                className="min-h-11 flex-row items-center gap-2.5 px-3"
              >
                {index === 0 ? null : (
                  <View className="absolute top-0 right-0 left-3 h-px bg-border" />
                )}
                <AskTargetIcon
                  environmentId={props.environmentId}
                  target={target}
                  projectsById={props.projectsById}
                  size={16}
                />
                <Text className="flex-1 text-[15px] text-foreground" numberOfLines={1}>
                  {card.question}
                </Text>
                <Text
                  className={
                    target.answer !== null
                      ? "text-[13px] text-foreground-secondary"
                      : "text-[13px] text-foreground-muted"
                  }
                >
                  {target.answer !== null ? "Answered" : "Waiting"}
                </Text>
              </View>
            ))}
          </View>
          {card.targets.map((target) =>
            target.answer === null ? null : (
              <View
                key={`answer:${target.coordinatorThreadId}`}
                className="mt-2.5 rounded-xl bg-card px-3 py-2.5"
              >
                <View className="flex-row items-center gap-1.5">
                  <AskTargetIcon
                    environmentId={props.environmentId}
                    target={target}
                    projectsById={props.projectsById}
                    size={13}
                  />
                  <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
                    {`${target.title} coordinator`}
                  </Text>
                </View>
                <Text className="mt-1 text-[15px] leading-[21px] text-foreground">
                  {target.answer.text}
                </Text>
              </View>
            ),
          )}
        </View>
      ))}
    </View>
  );
}

/** "3 need you  Payments retry, PDF export" above the composer. */
export function NeedsYouPill(props: {
  readonly items: ReadonlyArray<NeedsYouItem>;
  readonly onPress: () => void;
}) {
  const text = needsYouPillText(props.items);
  return (
    <View className="px-3 pb-2">
      <Pressable
        accessibilityHint="Shows what needs you"
        accessibilityLabel={`${text.count}: ${text.titles}`}
        accessibilityRole="button"
        className="min-h-11 flex-row items-center gap-2 rounded-[14px] border border-warning-border bg-warning pr-3 pl-3.5"
        onPress={props.onPress}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <ThreadStatusDot color={NEEDS_YOU_DOT_COLOR} grouped />
        <Text className="text-[14px] font-t3-semibold text-warning-foreground">{text.count}</Text>
        <Text className="flex-1 text-[14px] text-foreground-muted" numberOfLines={1}>
          {text.titles}
        </Text>
        <SymbolView
          name="chevron.right"
          size={13}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </View>
  );
}
