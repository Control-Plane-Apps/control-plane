import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ThreadStatusDot } from "../threads/thread-status-dot";
import { NEEDS_YOU_DOT_COLOR } from "./AssistantHomeRow";
import { needsYouAnswerLabel, needsYouKey } from "./assistantScreen.logic";
import { type NeedsYouActions, type NeedsYouItem } from "./useNeedsYouActions";

// Fork-owned. The Assistant's "Needs you" cards: one open Status question per
// row, with the one-tap answer, Reply, and a way into its Project.

const pressedOpacity = ({ pressed }: { readonly pressed: boolean }) => ({
  opacity: pressed ? 0.6 : 1,
});

/** A section label above a card group: "Needs you 3", with an optional trailing action. */
export function AssistantSectionHeader(props: {
  readonly label: string;
  readonly count: number;
  readonly tone: "warning" | "muted";
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  const color = props.tone === "warning" ? "text-warning-foreground" : "text-foreground-muted";
  return (
    <View className="min-h-8 flex-row items-center gap-1.5 pr-1 pb-1.5 pl-5">
      <Text className={`text-[13px] font-t3-medium ${color}`}>{props.label}</Text>
      <Text className={`text-[13px] tabular-nums opacity-85 ${color}`}>{props.count}</Text>
      <View className="flex-1" />
      {props.action ? (
        <Pressable
          accessibilityRole="button"
          className="h-8 justify-center px-1"
          hitSlop={6}
          onPress={props.action.onPress}
          style={pressedOpacity}
        >
          <Text className="text-[13px] font-t3-semibold text-foreground">{props.action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function NeedsYouRow(props: {
  readonly item: NeedsYouItem;
  readonly first: boolean;
  readonly sent: boolean;
  readonly actions: NeedsYouActions;
}) {
  const { item, actions } = props;
  const { project, status } = item;
  const label = needsYouAnswerLabel(status.decision);
  return (
    <View className="pt-2.5 pr-3 pb-1 pl-4">
      {props.first ? null : (
        <View className="absolute top-0 right-0 left-4 h-px bg-border" pointerEvents="none" />
      )}
      <View className="flex-row items-center gap-1.5">
        <ThreadStatusDot color={NEEDS_YOU_DOT_COLOR} grouped />
        <ProjectFavicon
          environmentId={project.environmentId}
          faviconPath={project.faviconPath}
          fallback="letter"
          projectIcon={project.projectIcon}
          projectTitle={project.title}
          size={13}
          workspaceRoot={project.workspaceRoot}
        />
        <Text className="flex-1 text-[13px] text-foreground-muted" numberOfLines={1}>
          <Text className="font-t3-semibold text-[13px] text-foreground">{status.title}</Text>
          {` · ${project.title}`}
        </Text>
      </View>
      <Text className="mt-[3px] text-[15px] leading-[20px] text-foreground">
        {status.decision.question}
      </Text>
      <View className="-ml-1 flex-row items-center gap-0.5">
        <Pressable
          accessibilityLabel={props.sent ? `Sent: ${label}` : label}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.sent }}
          className="h-11 justify-center px-1"
          disabled={props.sent}
          onPress={() => actions.answer(item)}
          style={pressedOpacity}
        >
          <View
            className={
              props.sent
                ? "h-[30px] flex-row items-center gap-1 rounded-full bg-subtle-strong px-3"
                : "h-[30px] flex-row items-center gap-1 rounded-full bg-primary px-3"
            }
          >
            <SymbolView
              name="checkmark"
              size={12}
              tintColorClassName={
                props.sent ? "accent-foreground-muted" : "accent-primary-foreground"
              }
              type="monochrome"
              weight="bold"
            />
            <Text
              className={
                props.sent
                  ? "text-[14px] font-t3-semibold text-foreground-muted"
                  : "text-[14px] font-t3-semibold text-primary-foreground"
              }
              numberOfLines={1}
            >
              {props.sent ? "Sent" : label}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel={`Reply to ${status.title}`}
          accessibilityRole="button"
          className="h-11 justify-center px-2.5"
          onPress={() => actions.reply(item)}
          style={pressedOpacity}
        >
          <Text className="text-[14px] font-t3-semibold text-foreground">Reply</Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable
          accessibilityLabel={`Open ${status.title}`}
          accessibilityRole="button"
          className="size-11 items-center justify-center"
          onPress={() => actions.open(item)}
          style={pressedOpacity}
        >
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
    </View>
  );
}

/** The cards in one rounded group. */
export function NeedsYouList(props: {
  readonly items: ReadonlyArray<NeedsYouItem>;
  readonly sentKeys: ReadonlySet<string>;
  readonly actions: NeedsYouActions;
}) {
  return (
    <View className="overflow-hidden rounded-xl bg-card">
      {props.items.map((item, index) => (
        <NeedsYouRow
          key={`${item.project.environmentId}:${item.project.id}:${item.status.id}`}
          item={item}
          first={index === 0}
          sent={props.sentKeys.has(needsYouKey(item.status, item.status.decision))}
          actions={props.actions}
        />
      ))}
    </View>
  );
}
