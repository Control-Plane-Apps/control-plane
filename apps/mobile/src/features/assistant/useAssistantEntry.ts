import { collectNeedsYou } from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_SERVER_SETTINGS, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { isAssistantPending, pickAssistantEnvironment } from "./assistantScreen.logic";

// Fork-owned. The Home row's Assistant: which environment hosts it, how many
// Status questions wait across that environment's Projects, and opening it,
// which creates it on first use.

export interface AssistantEntry {
  /** Null while `pending`: the row holds its place until an environment answers. */
  readonly environmentId: EnvironmentId | null;
  readonly pending: boolean;
  readonly project: EnvironmentProject | null;
  readonly needsYouCount: number;
  readonly opening: boolean;
  readonly open: () => void;
}

export function useAssistantEntry(input: {
  readonly onOpenThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}): AssistantEntry | null {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const ensure = useAtomCommand(serverEnvironment.assistantEnsure, { reportFailure: false });
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);

  const candidates = useMemo(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        connected: environment.connection.phase === "connected",
        supportsAssistants: environment.serverConfig?.environment.capabilities.assistants === true,
        configKnown: environment.serverConfig != null,
      })),
    [environments],
  );
  const picked = useMemo(
    () => pickAssistantEnvironment(candidates, projects),
    [candidates, projects],
  );
  const pending = picked === null && isAssistantPending(candidates);
  const environment =
    picked === null
      ? null
      : (environments.find((entry) => entry.environmentId === picked.environmentId) ?? null);
  const serverConfig = environment?.serverConfig ?? null;
  const reach = serverConfig?.settings.assistant?.projects ?? null;
  const needsYouCount = useMemo(() => {
    if (picked === null) return 0;
    return collectNeedsYou(
      projects.filter((project) => project.environmentId === picked.environmentId),
      reach,
    ).length;
  }, [picked, projects, reach]);

  const { onOpenThread } = input;
  const open = useCallback(() => {
    if (picked === null || openingRef.current) return;
    const coordinatorThreadId = picked.project?.assistant?.coordinatorThreadId;
    // Already here: open it without a round trip.
    if (coordinatorThreadId !== undefined) {
      onOpenThread({ environmentId: picked.environmentId, id: coordinatorThreadId });
      return;
    }
    const settings = resolveProjectSettings(
      serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
      null,
      null,
    ).settings;
    const projectDefault = resolveDefaultableModelSelection(
      serverConfig,
      settings.defaultModelSelection,
    );
    const modelSelection = resolveNewTaskModelSelection({
      draftSelection: null,
      projectDefaultSelection: projectDefault,
      stickySelection: null,
      modelOptions: buildModelOptions(serverConfig, projectDefault),
    });
    if (modelSelection === null) {
      Alert.alert(
        "Could not open the Assistant",
        "Turn on a model provider on this environment first.",
      );
      return;
    }
    openingRef.current = true;
    setOpening(true);
    void ensure({
      environmentId: picked.environmentId,
      input: { modelSelection, runtimeMode: settings.defaultRuntimeMode },
    }).then((result) => {
      openingRef.current = false;
      setOpening(false);
      if (AsyncResult.isSuccess(result)) {
        onOpenThread({ environmentId: picked.environmentId, id: result.value.threadId });
        return;
      }
      if (AsyncResult.isFailure(result) && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not open the Assistant",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "An error occurred.",
        );
      }
    });
  }, [ensure, onOpenThread, picked, serverConfig]);

  if (picked === null) {
    return pending
      ? {
          environmentId: null,
          pending: true,
          project: null,
          needsYouCount: 0,
          opening: false,
          open: noop,
        }
      : null;
  }
  return {
    environmentId: picked.environmentId,
    pending: false,
    project: picked.project,
    needsYouCount,
    opening,
    open,
  };
}

function noop() {}
