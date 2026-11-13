import {
  askAnswerMessageIds,
  assistantWorkingOn,
  collectAskCards,
  collectNeedsYou,
  isGlobalAssistant,
} from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { AndroidHeaderAction } from "../../components/AndroidScreenHeader";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { useAppNavigation } from "../threads/sidebar-navigation-shell";
import { AssistantMark } from "./AssistantMark";
import { AssistantAskCards, AssistantOverview, NeedsYouPill } from "./AssistantScreenParts";
import {
  anchorAskCards,
  withoutAskActivities,
  latestAssistantBrief,
  withoutAnsweredMessages,
} from "./assistantScreen.logic";
import { useNeedsYouActions, useSentNeedsYouKeys } from "./useNeedsYouActions";

// Fork-owned. Turns the thread screen into the iPhone Assistant when the open
// thread is the cross-Project Assistant's coordinator: its compact header,
// the overview above the conversation, ask cards inside it, and the
// Needs-you pill above the composer. Null for every other thread.

/** The centered title: the mark and "Assistant", with the channel under it. */
export function AssistantHeaderTitle() {
  return (
    <View accessibilityLabel="Assistant, Today" accessible className="items-center">
      <View className="flex-row items-center gap-[5px]">
        <AssistantMark size={15} />
        <Text className="text-[17px] font-t3-semibold text-foreground">Assistant</Text>
      </View>
      <View className="flex-row items-center gap-0.5">
        <Text className="text-[12px] text-foreground-muted">Today</Text>
        <SymbolView
          name="chevron.down"
          size={9}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
          weight="semibold"
        />
      </View>
    </View>
  );
}

export interface AssistantScreen<E> {
  readonly feed: ReadonlyArray<E>;
  readonly listHeader: ReactNode;
  readonly renderEntryAccessory: (entry: { readonly id: string }) => ReactNode;
  readonly composerAccessory: ReactNode;
  readonly composerPlaceholder: string;
  readonly iosRightItems: ReadonlyArray<NativeStackHeaderItem>;
  readonly androidActions: ReadonlyArray<AndroidHeaderAction>;
}

export function useAssistantScreen<
  E extends {
    readonly id: string;
    readonly type: string;
    readonly createdAt: string;
    readonly message?: { readonly id: string; readonly role: string };
  },
>(input: {
  readonly project: EnvironmentProject | null;
  readonly threadId: ThreadId | null;
  readonly detail: Pick<OrchestrationThread, "messages" | "activities"> | null;
  readonly feed: ReadonlyArray<E>;
}): AssistantScreen<E> | null {
  const { project, detail } = input;
  const active =
    project !== null &&
    isGlobalAssistant(project) &&
    project.assistant?.coordinatorThreadId === input.threadId;
  const navigation = useAppNavigation();
  const projects = useProjects();
  const serverConfig = useEnvironmentServerConfig(active ? project.environmentId : null);
  const actions = useNeedsYouActions();
  const sentKeys = useSentNeedsYouKeys();
  const reach = serverConfig?.settings.assistant?.projects ?? null;
  const environmentId = project?.environmentId ?? null;

  const environmentProjects = useMemo(
    () => (active ? projects.filter((candidate) => candidate.environmentId === environmentId) : []),
    [active, environmentId, projects],
  );
  const projectsById = useMemo(
    () => new Map(environmentProjects.map((candidate) => [candidate.id as string, candidate])),
    [environmentProjects],
  );
  const needsYou = useMemo(
    () => (active ? collectNeedsYou(environmentProjects, reach) : []),
    [active, environmentProjects, reach],
  );
  const workingOn = useMemo(() => (active ? assistantWorkingOn(project) : []), [active, project]);
  const brief = useMemo(
    () => (active && detail !== null ? latestAssistantBrief(detail.messages, project.id) : null),
    [active, detail, project],
  );
  const askCards = useMemo(
    () => (active && detail !== null ? collectAskCards(detail.activities, detail.messages) : []),
    [active, detail],
  );
  const feed = useMemo(
    () =>
      active
        ? withoutAskActivities(
            withoutAnsweredMessages(input.feed, askAnswerMessageIds(askCards)),
            new Set(askCards.map((card) => card.activityId)),
          )
        : input.feed,
    [active, askCards, input.feed],
  );
  const anchoredCards = useMemo(() => anchorAskCards(feed, askCards), [askCards, feed]);

  const seeAllNeedsYou = useCallback(() => {
    if (environmentId === null) return;
    navigation.navigate("AssistantNeedsYou", { environmentId: String(environmentId) });
  }, [environmentId, navigation]);
  const openSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "Settings" },
    });
  }, [navigation]);

  const renderEntryAccessory = useCallback(
    (entry: { readonly id: string }) => {
      const cards = anchoredCards.get(entry.id);
      if (cards === undefined || environmentId === null) return null;
      return (
        <AssistantAskCards
          environmentId={environmentId}
          cards={cards}
          projectsById={projectsById}
        />
      );
    },
    [anchoredCards, environmentId, projectsById],
  );

  const header = useMemo(() => {
    const iosRightItems: NativeStackHeaderItem[] = [
      withNativeGlassHeaderItem({
        type: "button",
        label: "",
        accessibilityLabel: "Assistant settings",
        icon: { type: "sfSymbol" as const, name: "gearshape" as const },
        identifier: "assistant-settings",
        onPress: openSettings,
      }),
    ];
    const androidActions: AndroidHeaderAction[] = [
      { accessibilityLabel: "Assistant settings", icon: "gearshape", onPress: openSettings },
    ];
    return { iosRightItems, androidActions };
  }, [openSettings]);

  const listHeader = useMemo(
    () => (
      <AssistantOverview
        brief={brief}
        needsYou={needsYou}
        sentKeys={sentKeys}
        workingOn={workingOn}
        actions={actions}
        onSeeAllNeedsYou={seeAllNeedsYou}
      />
    ),
    [actions, brief, needsYou, seeAllNeedsYou, sentKeys, workingOn],
  );
  const composerAccessory = useMemo(
    () => (needsYou.length > 0 ? <NeedsYouPill items={needsYou} onPress={seeAllNeedsYou} /> : null),
    [needsYou, seeAllNeedsYou],
  );

  if (!active) return null;
  return {
    feed,
    listHeader,
    renderEntryAccessory,
    composerAccessory,
    composerPlaceholder: "Ask your assistant",
    iosRightItems: header.iosRightItems,
    androidActions: header.androidActions,
  };
}
