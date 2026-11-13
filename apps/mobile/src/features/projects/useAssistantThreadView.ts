import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AgentMessageTimeline } from "@t3tools/client-runtime/state/assistant-thread-view";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { StackActions } from "@react-navigation/native";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import {
  assistantThreadRole,
  isArchivedAssistant,
  isStandingAgent,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { projectNeedsYouCount } from "@t3tools/client-runtime/state/projects";

import type { AndroidHeaderAction } from "../../components/AndroidScreenHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { useTaskPalette } from "../tasks/taskUi";
import { useAppNavigation } from "../threads/sidebar-navigation-shell";
import { resolveAssistantHeaderActions } from "./assistantThreadHeader";
import { buildProjectMenuItems, type ProjectMenuAction } from "./projectMenus";
import { runProjectMenuAction, useProjectActions } from "./useProjectActions";

// Fork-owned. The thread screen's Project chrome: the header items of a
// coordinator or agent, and the timeline the feed reads for handoff rows.

type HeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;
type SfSymbolName = Extract<HeaderIcon, { type: "sfSymbol" }>["name"];

function sfSymbolIcon(name: SfSymbolName): HeaderIcon {
  return { type: "sfSymbol", name };
}

/**
 * Opens another thread of the Project from inside a thread. Beside the iPad
 * sidebar it replaces the detail pane, as a sidebar selection does; on phone
 * it pushes, so Back returns to the thread the link was in.
 */
function useOpenProjectThread(): (environmentId: EnvironmentId, threadId: ThreadId) => void {
  const navigation = useAppNavigation();
  const { usesSplitView } = useAdaptiveWorkspaceLayout().layout;
  return useCallback(
    (environmentId, threadId) => {
      const params = { environmentId: String(environmentId), threadId: String(threadId) };
      if (usesSplitView) navigation.navigate("Thread", params);
      else navigation.dispatch(StackActions.push("Thread", params));
    },
    [navigation, usesSplitView],
  );
}

interface AssistantHeaderThread {
  readonly id: ThreadId;
  readonly pinnedAt?: string | null | undefined;
  readonly worktreePath: string | null;
}

/**
 * Header items for a thread in a Project. The coordinator gets Memory,
 * Schedules (when its server stores them) and the Project menu; an agent
 * names its Project in the subtitle and gets a button to its coordinator.
 * Plain threads get nothing and keep their git controls.
 */
export function useAssistantThreadHeader(input: {
  readonly project: EnvironmentProject | null;
  readonly thread: AssistantHeaderThread | null;
  readonly isGitRepo: boolean;
  /** Leaves the coordinator once its Project is deleted from the header. */
  readonly onProjectDeleted: () => void;
  /** Opens the coordinator's Status board (full screen on phone, beside it on iPad). */
  readonly onOpenStatus?: () => void;
}): {
  readonly showGitControls: boolean;
  readonly subtitle: string | null;
  readonly iosItems: ReadonlyArray<NativeStackHeaderItem>;
  readonly androidActions: ReadonlyArray<AndroidHeaderAction>;
} {
  const { project, thread, onProjectDeleted, onOpenStatus } = input;
  const projectActions = useProjectActions();
  const openProjectThread = useOpenProjectThread();
  const role = assistantThreadRole(project, thread?.id);
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const { showGitControls, memory, schedules, projectMenu, openProject } =
    resolveAssistantHeaderActions({
      role,
      isStanding: thread !== null && isStandingAgent(project, thread),
      worktreePath: thread?.worktreePath ?? null,
      isGitRepo: input.isGitRepo,
      canSchedule: serverConfig?.environment.capabilities.projectSchedules !== undefined,
    });
  const archived = isArchivedAssistant(project);
  const { usesSplitView } = useAdaptiveWorkspaceLayout().layout;
  // The Status pill: the coordinator only, on servers that keep a Status board.
  const statusAvailable =
    role === "coordinator" &&
    onOpenStatus !== undefined &&
    serverConfig?.environment.capabilities.projectStatus === true;
  const needsYou = project === null ? 0 : projectNeedsYouCount(project);
  const statusTint = useTaskPalette().warningText;

  const items = useMemo(() => {
    const iosItems: NativeStackHeaderItem[] = [];
    const androidActions: AndroidHeaderAction[] = [];
    if (project === null) return { iosItems, androidActions };

    // On phone the Status pill needs the bar's room: Memory and Schedules
    // move into the Project menu instead of taking their own buttons.
    const foldIntoMenu = statusAvailable && !usesSplitView;
    const folded: Array<{ label: string; icon: SfSymbolName; onPress: () => void }> = [];

    if (statusAvailable && onOpenStatus !== undefined) {
      // A text item, not a custom view: UIKit lays custom views out only
      // when the bar has room, and the coordinator's bar is full on phone.
      const label =
        needsYou > 0
          ? usesSplitView
            ? `Status \u00b7 ${needsYou} need you`
            : `${needsYou} need you`
          : "Status";
      iosItems.push(
        withNativeGlassHeaderItem({
          type: "button",
          label,
          labelStyle: needsYou > 0 ? { color: statusTint, fontWeight: "600" } : undefined,
          accessibilityLabel: needsYou > 0 ? `Status, ${needsYou} need you` : "Status",
          identifier: "thread-right-status",
          onPress: onOpenStatus,
        }),
      );
      androidActions.push({
        accessibilityLabel: needsYou > 0 ? `Status, ${needsYou} need you` : "Status",
        icon: { ios: "checklist", android: "check" },
        onPress: onOpenStatus,
      });
    }

    if (memory) {
      const openMemory = () => projectActions.openProjectFile(project, "MEMORY.md");
      if (foldIntoMenu) folded.push({ label: "Memory", icon: "book.closed", onPress: openMemory });
      else
        iosItems.push(
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "Memory",
            icon: sfSymbolIcon("book.closed"),
            identifier: "thread-right-memory",
            onPress: openMemory,
          }),
        );
      androidActions.push({
        accessibilityLabel: "Memory",
        icon: "book.closed",
        onPress: openMemory,
      });
    }

    if (schedules) {
      const openSchedules = () => projectActions.openSchedules(project);
      if (foldIntoMenu) folded.push({ label: "Schedules", icon: "clock", onPress: openSchedules });
      else
        iosItems.push(
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "Schedules",
            icon: sfSymbolIcon("clock"),
            identifier: "thread-right-schedules",
            onPress: openSchedules,
          }),
        );
      androidActions.push({
        accessibilityLabel: "Schedules",
        icon: "clock",
        onPress: openSchedules,
      });
    }

    if (projectMenu) {
      const run = (action: ProjectMenuAction) => {
        // The header menu has no New agent.
        if (action === "new-agent") return;
        void runProjectMenuAction(projectActions, project, action).then((done) => {
          if (action === "delete" && done) onProjectDeleted();
        });
      };
      const menu = buildProjectMenuItems({ surface: "header", archived });
      iosItems.push(
        withNativeGlassHeaderItem({
          type: "menu",
          label: "",
          accessibilityLabel: "Project actions",
          icon: sfSymbolIcon("folder.badge.gearshape"),
          identifier: "thread-right-project",
          menu: {
            title: project.title,
            items: [
              ...folded.map((item) => ({
                type: "action" as const,
                label: item.label,
                icon: sfSymbolIcon(item.icon),
                onPress: item.onPress,
              })),
              ...menu.map((item) => ({
                type: "action" as const,
                label: item.title,
                icon: sfSymbolIcon(item.icon),
                ...(item.destructive ? { destructive: true } : {}),
                onPress: () => run(item.id),
              })),
            ],
          },
        }),
      );
      for (const item of menu) {
        androidActions.push({
          accessibilityLabel: item.title,
          icon: item.icon,
          onPress: () => run(item.id),
        });
      }
    }

    const coordinatorThreadId = project.assistant?.coordinatorThreadId;
    if (openProject && coordinatorThreadId !== undefined) {
      const label = `Open ${project.title}`;
      // By id, so it works before the coordinator's shell arrives.
      const open = () => openProjectThread(project.environmentId, coordinatorThreadId);
      iosItems.push(
        withNativeGlassHeaderItem({
          type: "button",
          label: "",
          accessibilityLabel: label,
          icon: sfSymbolIcon("arrow.turn.left.up"),
          identifier: "thread-right-open-project",
          onPress: open,
        }),
      );
      androidActions.push({ accessibilityLabel: label, icon: "arrow.turn.left.up", onPress: open });
    }
    return { iosItems, androidActions };
  }, [
    archived,
    needsYou,
    onOpenStatus,
    statusTint,
    statusAvailable,
    usesSplitView,
    memory,
    onProjectDeleted,
    openProject,
    openProjectThread,
    project,
    projectActions,
    projectMenu,
    schedules,
  ]);

  return {
    showGitControls,
    // The coordinator's title is the Project name already.
    subtitle: role === "agent" && project !== null ? project.title : null,
    iosItems: items.iosItems,
    androidActions: items.androidActions,
  };
}

/** The Project a thread's feed belongs to, for handoff rows and links between its threads. */
export interface AssistantFeedTimeline extends AgentMessageTimeline {
  readonly project: Pick<
    EnvironmentProject,
    "environmentId" | "title" | "faviconPath" | "projectIcon" | "workspaceRoot"
  >;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

/** Null outside a Project. Stable while the Project and the thread's role hold. */
export function useAssistantFeedTimeline(
  project: EnvironmentProject | null,
  threadId: ThreadId | null,
): AssistantFeedTimeline | null {
  const openProjectThread = useOpenProjectThread();
  const role = assistantThreadRole(project, threadId);
  return useMemo(() => {
    const coordinatorThreadId = project?.assistant?.coordinatorThreadId;
    if (project === null || role === null || coordinatorThreadId === undefined) return null;
    const { environmentId, id: projectId } = project;
    return {
      role,
      coordinatorThreadId,
      project,
      projectThreadTitle: (linkedThreadId) => {
        const linked = appAtomRegistry.get(
          environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, linkedThreadId)),
        );
        return linked?.projectId === projectId ? linked.title : null;
      },
      onOpenThread: (linkedThreadId) => openProjectThread(environmentId, linkedThreadId),
    };
  }, [openProjectThread, project, role]);
}
