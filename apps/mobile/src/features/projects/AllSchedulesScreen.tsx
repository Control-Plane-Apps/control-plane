import { StackActions, useNavigation } from "@react-navigation/native";
import { listScheduleProjects } from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { ScheduleListBody, useProjectScheduleList } from "./ProjectSchedulesScreen";

// Fork-owned. Every schedule across Projects, the Assistant's first: one
// section per Project with the same rows, switches and editor as a Project's
// own Schedules screen.

export function AllSchedulesScreen() {
  const insets = useSafeAreaInsets();
  const entries = listScheduleProjects(useProjects());
  return (
    <View className="flex-1 bg-sheet">
      <View collapsable={false} pointerEvents="none" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {entries.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            detail="Ask a Project coordinator or the Assistant to send a prompt on a cadence."
          />
        ) : (
          entries.map((entry) => (
            <ProjectSection
              key={`${entry.project.environmentId}:${entry.project.id}`}
              project={entry.project}
              label={entry.label}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function ProjectSection(props: { readonly project: EnvironmentProject; readonly label: string }) {
  const { project } = props;
  const navigation = useNavigation();
  const capability = useEnvironmentServerConfig(project.environmentId)?.environment.capabilities
    .projectSchedules;
  const list = useProjectScheduleList(project.environmentId, project.id);
  if (capability === undefined) return null;
  const openEditor = (scheduleId: string | null) =>
    navigation.dispatch(
      StackActions.push("SettingsProjectScheduleEditor", {
        environmentId: String(project.environmentId),
        projectId: String(project.id),
        ...(scheduleId === null ? {} : { scheduleId }),
      }),
    );
  return (
    <View className="gap-2">
      <Text
        accessibilityRole="header"
        className="px-2 text-sm font-t3-bold uppercase text-foreground-muted"
      >
        {props.label}
      </Text>
      <ScheduleListBody list={list} onOpenEditor={openEditor} />
    </View>
  );
}
