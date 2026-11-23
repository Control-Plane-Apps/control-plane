import { useAtomValue, RegistryContext } from "@effect/atom-react";
import { mergeAssistantNeedsYou } from "@t3tools/client-runtime/state/assistant-home";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type {
  AssistantNeedsYouEntry,
  AssistantNeedsYouResult,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useProjects } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { environmentShell } from "~/state/shell";
import { useAssistantHomeEnvironment, useGlobalAssistantProject } from "./useAssistant";

const sourcesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const liveEnvironmentIds = new Set<EnvironmentId>();
  const machineLabels = new Map<EnvironmentId, string>();
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const entry = catalog.entries.get(environmentId);
    if (entry) machineLabels.set(environmentId, entry.target.label);
    if (
      presentations.get(environmentId)?.connection.phase === "connected" &&
      get(environmentShell.stateValueAtom(environmentId)).status === "live"
    ) {
      liveEnvironmentIds.add(environmentId);
    }
  }
  return { liveEnvironmentIds, machineLabels };
});

export interface AssistantNeedsYouState {
  readonly items: ReadonlyArray<AssistantNeedsYouEntry>;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly machines: AssistantNeedsYouResult["machines"];
  readonly refresh: () => void;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
}

/** All consumers subscribe to the same home-server query, including its refresh timer. */
export function useAssistantNeedsYouState(): AssistantNeedsYouState {
  const projects = useProjects();
  const assistant = useGlobalAssistantProject();
  const home = useAssistantHomeEnvironment();
  const homeId = assistant === null ? null : (home?.environmentId ?? null);
  const reach = home?.serverConfig?.settings.assistant?.projects ?? null;
  const registry = useContext(RegistryContext);
  const query = useMemo(
    () =>
      Atom.make((get) =>
        homeId === null
          ? null
          : get(serverEnvironment.assistantNeedsYou({ environmentId: homeId, input: {} })),
      ),
    [homeId],
  );
  const result = useAtomValue(query);
  const { liveEnvironmentIds, machineLabels } = useAtomValue(sourcesAtom);
  const aggregate = result === null ? null : Option.getOrNull(AsyncResult.value(result));
  const homeUnavailable = homeId !== null && home?.connection.phase !== "connected";
  const failed =
    result?._tag === "Failure" ||
    (homeUnavailable && (aggregate !== null || home?.connection.phase !== "connecting"));
  const aggregateItems = useMemo(
    () =>
      aggregate === null
        ? null
        : failed || homeUnavailable
          ? aggregate.items.map((item) => ({ ...item, stale: true }))
          : aggregate.items,
    [aggregate, failed, homeUnavailable],
  );
  const items = useMemo(
    () =>
      mergeAssistantNeedsYou({
        projects,
        reach,
        aggregateItems,
        liveEnvironmentIds,
        machineLabels,
      }),
    [projects, reach, aggregateItems, liveEnvironmentIds, machineLabels],
  );
  const refresh = useCallback(() => {
    if (homeId !== null)
      registry.refresh(serverEnvironment.assistantNeedsYou({ environmentId: homeId, input: {} }));
  }, [homeId, registry]);
  return {
    items,
    loading: result?._tag === "Initial",
    failed,
    machines: aggregate?.machines ?? [],
    refresh,
    liveEnvironmentIds,
  };
}

/** Shared list for the sidebar badge, Overview and empty conversation. */
export function useAssistantNeedsYou() {
  return useAssistantNeedsYouState().items;
}
