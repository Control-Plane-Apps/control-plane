import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  findGlobalAssistantProject,
  withoutGlobalAssistant,
} from "@t3tools/client-runtime/state/assistant-home";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  type ProjectStatus,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { newMessageId } from "~/lib/utils";
import { useEnvironment, usePrimaryEnvironment } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { recommendationReplyText } from "../status/projectStatus.logic";
import { toastManager } from "../ui/toast";

// Fork-owned. Hooks that find, open and act for the cross-Project Assistant.

/**
 * The Assistant's Project on whichever connected environment runs it: this
 * machine's first, else a linked machine the client is also connected to.
 * Exactly one server runs it; another server's archived copy never counts.
 */
export function useGlobalAssistantProject(): EnvironmentProject | null {
  const projects = useProjects();
  const environment = usePrimaryEnvironment();
  return useMemo(() => {
    const primaryId = environment?.environmentId ?? null;
    const primary = findGlobalAssistantProject(
      projects.filter((project) => project.environmentId === primaryId),
    );
    return primary ?? findGlobalAssistantProject(projects) ?? null;
  }, [environment, projects]);
}

/** The environment whose settings and machines the Assistant pages use: its home if connected, else this machine. */
export function useAssistantHomeEnvironment() {
  const project = useGlobalAssistantProject();
  const primary = usePrimaryEnvironment();
  const home = useEnvironment(project?.environmentId ?? null);
  return home ?? primary;
}

/** Every Project except the Assistant, across environments. */
export function useProjectsWithoutAssistant(): EnvironmentProject[] {
  const projects = useProjects();
  return useMemo(() => withoutGlobalAssistant(projects), [projects]);
}

/** Opens the Assistant, creating it on first use. */
export function useOpenAssistant() {
  const navigate = useNavigate();
  const environment = usePrimaryEnvironment();
  const existing = useGlobalAssistantProject();
  const ensure = useAtomCommand(serverEnvironment.assistantEnsure, { reportFailure: false });
  const [opening, setOpening] = useState(false);

  const open = useCallback(async () => {
    if (environment === null) return;
    const environmentId = environment.environmentId;
    const go = (threadId: ThreadId) =>
      navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    if (existing?.assistant != null) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(existing.environmentId, existing.assistant.coordinatorThreadId),
        ),
      });
      return;
    }
    const settings = environment.serverConfig?.settings;
    if (!settings) return;
    setOpening(true);
    const result = await ensure({
      environmentId,
      input: {
        modelSelection: settings.defaultModelSelection ?? settings.textGenerationModelSelection,
        runtimeMode: settings.defaultRuntimeMode,
      },
    });
    setOpening(false);
    if (result._tag === "Success") {
      await go(result.value.threadId);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not open the Assistant",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [ensure, environment, existing, navigate]);

  return { open, opening, environmentId: environment?.environmentId ?? null };
}

/**
 * Sends a message to a thread outside the one on screen, such as a
 * Project's coordinator when the user answers its Status question from the
 * Assistant.
 */
export function useSendToThread() {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly runtimeMode: RuntimeMode;
    }) => {
      const result = await startTurn({
        environmentId: input.environmentId,
        input: {
          threadId: input.threadId,
          message: { messageId: newMessageId(), role: "user", text: input.text, attachments: [] },
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not send",
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      return result._tag === "Success";
    },
    [startTurn],
  );
}

/** The "go with the recommendation" text for a Status question. */
export function recommendationTextFor(status: ProjectStatus): string | null {
  if (status.decision === undefined) return null;
  return recommendationReplyText(status, status.decision);
}
