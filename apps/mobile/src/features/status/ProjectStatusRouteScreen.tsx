import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useProject } from "../../state/entities";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { symbol } from "../tasks/taskUi";
import { ProjectStatusPanel } from "./ProjectStatusPanel";
import type { StatusReplyTag } from "./projectStatus.logic";
import { setStatusReplyTag } from "./statusReplyStore";

// Fork-owned. Status, full screen over the coordinator thread (phone).

type ProjectStatusRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
};

/** Puts the Re: chip (and an optional starter line) on the coordinator's composer. */
export function prepareStatusReply(
  project: EnvironmentProject,
  tag: StatusReplyTag,
  draft?: string,
): ThreadId | null {
  const coordinatorThreadId = project.assistant?.coordinatorThreadId;
  if (coordinatorThreadId === undefined) return null;
  const threadKey = scopedThreadKey(project.environmentId, coordinatorThreadId);
  setStatusReplyTag(threadKey, tag);
  if (draft !== undefined && getComposerDraftSnapshot(threadKey).text.trim().length === 0) {
    setComposerDraftText(threadKey, draft);
  }
  return coordinatorThreadId;
}

export function ProjectStatusRouteScreen({ route }: StaticScreenProps<ProjectStatusRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const project = useProject(
    scopeProjectRef(
      EnvironmentId.make(route.params.environmentId),
      ProjectId.make(route.params.projectId),
    ),
  );

  const returnToThread = useCallback(
    (threadId: ThreadId) => {
      if (project === null) return;
      const state = navigation.getState();
      const below = state?.routes[(state?.index ?? 0) - 1];
      const params = below?.params as { threadId?: string } | undefined;
      navigation.goBack();
      if (below?.name !== "Thread" || params?.threadId !== threadId) {
        navigation.dispatch(
          StackActions.push("Thread", {
            environmentId: String(project.environmentId),
            threadId: String(threadId),
          }),
        );
      }
    },
    [navigation, project],
  );

  // Full screen, not a sheet: a downward swipe on the header closes it, and
  // the screen follows the finger until it lets go.
  const dragY = useSharedValue(0);
  const close = useCallback(() => navigation.goBack(), [navigation]);
  const swipeToClose = Gesture.Pan()
    .activeOffsetY(12)
    .failOffsetX([-20, 20])
    .onUpdate((event) => {
      dragY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (event.translationY > 90 || event.velocityY > 900) {
        runOnJS(close)();
      } else {
        dragY.value = withSpring(0);
      }
    });
  const followFinger = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.value }] }));

  return (
    <Animated.View className="flex-1 bg-screen" style={[{ paddingTop: insets.top }, followFinger]}>
      {project === null ? null : (
        <>
          <GestureDetector gesture={swipeToClose}>
            <View className="flex-row items-start px-5 pb-1 pt-4">
              <View className="flex-1">
                <Text
                  className="text-[30px] font-t3-bold text-foreground"
                  accessibilityRole="header"
                >
                  Status
                </Text>
                <Text className="text-[15px] text-foreground-muted">
                  {project.title} coordinator
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close Status"
                onPress={() => navigation.goBack()}
                className="size-11 items-center justify-center rounded-full bg-secondary"
              >
                <SymbolView
                  name={symbol("xmark", "close")}
                  size={15}
                  tintColorClassName="accent-foreground"
                  type="monochrome"
                  weight="semibold"
                />
              </Pressable>
            </View>
          </GestureDetector>
          <ProjectStatusPanel
            project={project}
            onReply={(tag, draft) => {
              const threadId = prepareStatusReply(project, tag, draft);
              if (threadId !== null) returnToThread(threadId);
            }}
            onOpenThread={(threadId) => {
              navigation.goBack();
              navigation.dispatch(
                StackActions.push("Thread", {
                  environmentId: String(project.environmentId),
                  threadId: String(threadId),
                }),
              );
            }}
          />
        </>
      )}
    </Animated.View>
  );
}
