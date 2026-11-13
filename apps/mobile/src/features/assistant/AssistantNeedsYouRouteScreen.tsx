import { collectNeedsYou } from "@t3tools/client-runtime/state/assistant-home";
import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { NeedsYouList } from "./NeedsYouList";
import { useNeedsYouActions, useSentNeedsYouKeys } from "./useNeedsYouActions";

// Fork-owned. Every open Status question across the Assistant's Projects:
// "See all" and the Needs-you pill open it.

export type AssistantNeedsYouRouteParams = {
  readonly environmentId: string;
};

export function AssistantNeedsYouRouteScreen({
  route,
}: StaticScreenProps<AssistantNeedsYouRouteParams>) {
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projects = useProjects();
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const reach = serverConfig?.settings.assistant?.projects ?? null;
  const items = useMemo(
    () =>
      collectNeedsYou(
        projects.filter((project) => project.environmentId === environmentId),
        reach,
      ),
    [environmentId, projects, reach],
  );
  const actions = useNeedsYouActions();
  const sentKeys = useSentNeedsYouKeys();

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 24) }}
    >
      {items.length === 0 ? (
        <View className="pt-24">
          <EmptyState
            title="Nothing needs you"
            detail="Questions from your Projects show up here."
            variant="plain"
          />
        </View>
      ) : (
        <NeedsYouList items={items} sentKeys={sentKeys} actions={actions} />
      )}
    </ScrollView>
  );
}
