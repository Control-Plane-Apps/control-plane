import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { symbol } from "../tasks/taskUi";
import { ProjectStatusPanel } from "./ProjectStatusPanel";
import { prepareStatusReply } from "./ProjectStatusRouteScreen";

// Fork-owned. Status beside the coordinator thread on iPad. Reply lands in
// the composer next to it, so the pane stays open.

export function ProjectStatusInspector(props: {
  readonly project: EnvironmentProject;
  readonly headerInset: number;
  readonly onClose: () => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { project } = props;
  return (
    <View
      className="flex-1 border-l border-border bg-screen"
      style={{ paddingTop: Math.max(props.headerInset, insets.top) }}
    >
      <View className="min-h-[52px] flex-row items-center pl-5 pr-2">
        <Text
          className="flex-1 text-[20px] font-t3-bold text-foreground"
          accessibilityRole="header"
        >
          Status
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Status"
          onPress={props.onClose}
          className="size-11 items-center justify-center"
        >
          <SymbolView
            name={symbol("xmark", "close")}
            size={15}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
      <ProjectStatusPanel
        project={project}
        onReply={(tag, draft) => void prepareStatusReply(project, tag, draft)}
        onOpenThread={(threadId) =>
          navigation.navigate("Thread", {
            environmentId: String(project.environmentId),
            threadId: String(threadId),
          })
        }
      />
    </View>
  );
}
