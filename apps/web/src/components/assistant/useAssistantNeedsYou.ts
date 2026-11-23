import { collectNeedsYou } from "@t3tools/client-runtime/state/assistant-home";
import { useMemo } from "react";
import { useProjects } from "~/state/entities";
import { useAssistantHomeEnvironment } from "./useAssistant";

/** Shared list for the sidebar badge, Overview and empty conversation. */
export function useAssistantNeedsYou() {
  const projects = useProjects();
  const home = useAssistantHomeEnvironment();
  const reach = home?.serverConfig?.settings.assistant?.projects ?? null;
  return useMemo(() => collectNeedsYou(projects, reach), [projects, reach]);
}
