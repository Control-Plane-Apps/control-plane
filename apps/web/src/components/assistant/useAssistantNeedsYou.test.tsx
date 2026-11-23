import { EnvironmentId, type AssistantNeedsYouResult } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const source = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  reach: null as string[] | null,
  homePhase: "connected",
  peerPhase: "connected",
  sequences: new Map<string, number>(),
  refreshers: [] as Array<(registry: AtomRegistry.AtomRegistry) => void>,
  aggregate: { items: [], machines: [] } as AssistantNeedsYouResult,
}));
vi.mock("~/connection/catalog", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map(
          ["macbook", "mini"].map((id) => [id, { enabled: true, target: { label: id } }]),
        ),
      }),
    },
  };
});
vi.mock("~/state/presentation", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const presentations = Atom.make(
    () =>
      new Map(
        ["macbook", "mini"].map((id) => [
          id,
          { connection: { phase: id === "macbook" ? source.peerPhase : source.homePhase } },
        ]),
      ),
  );
  source.refreshers.push((registry) => registry.refresh(presentations));
  return { environmentPresentations: { presentationsAtom: presentations } };
});
vi.mock("~/state/shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Option = await import("effect/Option");
  const family = Atom.family((id: string) => {
    const shell = Atom.make(() => ({
      status: "live",
      snapshot: source.sequences.has(id)
        ? Option.some({ snapshotSequence: source.sequences.get(id)! })
        : Option.none(),
    }));
    source.refreshers.push((registry) => registry.refresh(shell));
    return shell;
  });
  return { environmentShell: { stateValueAtom: family } };
});
vi.mock("~/state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const aggregate = Atom.make(() => AsyncResult.success(source.aggregate));
  source.refreshers.push((registry) => registry.refresh(aggregate));
  return { serverEnvironment: { assistantNeedsYou: () => aggregate, assistantNeedsYouReply: {} } };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/environments", () => ({
  useEnvironment: (id: string) =>
    id === "server-only"
      ? null
      : { connection: { phase: id === "macbook" ? source.peerPhase : source.homePhase } },
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => source.projects,
  useThreadShell: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../status/ProjectStatusPanel", () => ({ useMinuteNow: () => Date.now() }));
vi.mock("./AssistantTodayTasks", () => ({ AssistantTodayTasks: () => null }));
vi.mock("./useAssistant", () => ({
  useGlobalAssistantProject: () => ({}),
  useOpenAssistant: () => ({ open: vi.fn(), opening: false }),
  useSendToThread: () => vi.fn(),
  useAssistantHomeEnvironment: () => ({
    environmentId: "mini",
    connection: { phase: source.homePhase },
    serverConfig: { settings: { assistant: { projects: source.reach } } },
  }),
}));
import { useAssistantNeedsYouState } from "./useAssistantNeedsYou";
import { SidebarAssistantRow } from "./SidebarAssistantRow";
import { AssistantOverview } from "./AssistantOverview";

function renderedText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | null): string {
  if (node === null) return "";
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return (
    node.children
      ?.map((child) => (typeof child === "string" ? child : renderedText(child)))
      .join("") ?? ""
  );
}

it("shares the list and count across servers using the Assistant home's reach", async () => {
  const project = (id: string, environmentId: string) =>
    ({
      id,
      title: id,
      environmentId,
      assistant: {
        coordinatorThreadId: `${id}-coord`,
        statuses: [
          {
            id: "assistant-tasks",
            title: "Status",
            state: "needs-you",
            updatedAt: "2026-11-23T00:00:00Z",
            decision: {
              question: "Continue?",
              recommendation: "Yes",
              openedAt: "2026-11-23T00:00:00Z",
            },
          },
        ],
      },
    }) as unknown as EnvironmentProject;
  source.projects = [project("control-plane", "macbook"), project("other", "mini")];
  const remote = project("server-only", "server-only");
  source.aggregate = {
    items: [
      {
        environmentId: remote.environmentId,
        machineLabel: "Unconnected server",
        projectId: remote.id,
        projectTitle: remote.title,
        coordinatorThreadId: remote.assistant!.coordinatorThreadId,
        status: {
          ...remote.assistant!.statuses![0]!,
          decision: remote.assistant!.statuses![0]!.decision!,
        },
        stale: false,
      },
    ],
    machines: [
      {
        environmentId: EnvironmentId.make("macbook"),
        label: "Direct MacBook",
        state: "offline",
        detail: "Home cannot reach it",
      },
    ],
  } satisfies AssistantNeedsYouResult;
  source.reach = ["control-plane", "server-only"];
  function Harness() {
    const state = useAssistantNeedsYouState();
    const rows = state.items;
    return (
      <>
        <SidebarAssistantRow isActive />
        <AssistantOverview
          assistant={{ assistant: { statuses: [] } } as unknown as EnvironmentProject}
          needsYou={rows}
          needsYouStatus={state}
          asks={[]}
        />
      </>
    );
  }
  const registry = AtomRegistry.make();
  const view = () => (
    <RegistryContext.Provider value={registry}>
      <Harness />
    </RegistryContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(view());
  });
  const update = () =>
    act(async () => {
      for (const refresh of source.refreshers) refresh(registry);
      renderer.update(view());
    });
  const assertConsumersAgree = (count: number) => {
    const badgeNodes = renderer.root.findAll(
      (node) =>
        typeof node.props["aria-label"] === "string" &&
        /questions? needs? you/.test(node.props["aria-label"]),
    );
    expect(badgeNodes).toHaveLength(count === 0 ? 0 : 1);
    if (count > 0) expect(badgeNodes[0]!.children).toEqual([String(count)]);
    expect(renderer.root.findAllByProps({ "data-testid": "assistant-needs-you-row" })).toHaveLength(
      count,
    );
  };
  assertConsumersAgree(2);
  expect(renderedText(renderer.toJSON())).toContain("control-plane");
  expect(renderedText(renderer.toJSON())).not.toContain("other");
  expect(renderedText(renderer.toJSON())).toContain("Unconnected server");
  expect(renderedText(renderer.toJSON())).not.toContain("Could not check Direct MacBook");
  expect(renderedText(renderer.toJSON())).not.toContain("Home cannot reach it");
  source.reach = null;
  await update();
  assertConsumersAgree(3);
  source.homePhase = "reconnecting";
  await update();
  assertConsumersAgree(2);
  expect(renderedText(renderer.toJSON())).toContain(
    "Could not refresh questions from the Assistant",
  );
  expect(renderedText(renderer.toJSON())).toContain("Last known question, machine unavailable");
  expect(renderer.root.findAllByType("button").some((button) => button.props.disabled)).toBe(true);
  source.homePhase = "connected";
  source.reach = [];
  await update();
  assertConsumersAgree(0);
  await act(async () => renderer.unmount());
  registry.dispose();
});

it("keeps badge and Overview on the freshest MacBook snapshot through stale peer data and recovery", async () => {
  source.homePhase = "connected";
  source.peerPhase = "connected";
  source.reach = null;
  source.sequences = new Map([
    ["macbook", 30],
    ["mini", 1],
  ]);
  const cp = {
    id: "control-plane",
    title: "Control Plane",
    environmentId: "macbook",
    workspaceRoot: "/tmp/control-plane",
    assistant: { coordinatorThreadId: "cp-coordinator", statuses: [] },
  } as unknown as EnvironmentProject;
  const hometrace = {
    id: "hometrace",
    title: "Hometrace",
    environmentId: "macbook",
    workspaceRoot: "/tmp/hometrace",
    assistant: {
      coordinatorThreadId: "hometrace-coordinator",
      statuses: [
        {
          id: "inspection-follow-up",
          title: "Inspection follow-up",
          state: "needs-you",
          summary: "Awaiting review",
          updatedAt: "2026-11-23T21:21:00.000Z",
          decision: {
            question: "Review the inspection?",
            recommendation: "Review",
            openedAt: "2026-11-23T21:21:00.000Z",
          },
        },
      ],
    },
  } as unknown as EnvironmentProject;
  const oldQuestion = {
    id: "assistant-tasks",
    title: "Cleared Assistant tasks",
    state: "needs-you" as const,
    summary: "Old cache",
    updatedAt: "2026-11-23T20:00:00.000Z",
    decision: {
      question: "Old cleared question?",
      recommendation: "Continue",
      openedAt: "2026-11-23T20:00:00.000Z",
    },
  };
  const cached = {
    environmentId: cp.environmentId,
    projectId: cp.id,
    projectTitle: cp.title,
    machineLabel: "MacBook",
    coordinatorThreadId: cp.assistant!.coordinatorThreadId,
    status: oldQuestion,
    stale: true,
  };
  source.projects = [cp, hometrace];
  source.aggregate = {
    items: [cached],
    machines: [
      {
        environmentId: cp.environmentId,
        label: "MacBook",
        state: "offline",
        detail: "did not answer in time",
        snapshotSequence: 10,
      },
    ],
  };
  function Harness() {
    const state = useAssistantNeedsYouState();
    return (
      <>
        <SidebarAssistantRow isActive />
        <AssistantOverview
          assistant={{ assistant: { statuses: [] } } as unknown as EnvironmentProject}
          needsYou={state.items}
          needsYouStatus={state}
          asks={[]}
        />
      </>
    );
  }
  const registry = AtomRegistry.make();
  const view = () => (
    <RegistryContext.Provider value={registry}>
      <Harness />
    </RegistryContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(view());
  });
  const update = () =>
    act(async () => {
      for (const refresh of source.refreshers) refresh(registry);
      renderer.update(view());
    });
  const assertCountAndRow = (projectTitle: string | null) => {
    const rows = renderer.root.findAllByProps({ "data-testid": "assistant-needs-you-row" });
    const badges = renderer.root.findAll(
      (node) =>
        typeof node.props["aria-label"] === "string" &&
        /questions? needs? you/.test(node.props["aria-label"]),
    );
    expect(rows).toHaveLength(projectTitle === null ? 0 : 1);
    expect(badges).toHaveLength(rows.length);
    if (rows.length) expect(badges[0]!.children).toEqual(["1"]);
    if (projectTitle !== null) expect(renderedText(renderer.toJSON())).toContain(projectTitle);
  };
  assertCountAndRow("Hometrace");
  expect(renderedText(renderer.toJSON())).not.toContain("Old cleared question");
  expect(renderedText(renderer.toJSON())).not.toContain("Could not check MacBook");
  expect(renderer.root.findAllByProps({ "data-testid": "assistant-needs-you-stale" })).toHaveLength(
    0,
  );

  // The browser disconnects, but its versioned snapshot is still newer than the mini's cache.
  source.peerPhase = "offline";
  await update();
  assertCountAndRow("Hometrace");
  expect(renderedText(renderer.toJSON())).not.toContain("Old cleared question");
  expect(renderedText(renderer.toJSON())).toContain("Last known question, machine unavailable");
  expect(renderedText(renderer.toJSON())).toContain("Could not check MacBook");
  expect(renderer.root.findAllByProps({ "data-testid": "assistant-needs-you-stale" })).toHaveLength(
    1,
  );
  const staleButtons = renderer.root
    .findAllByProps({ "data-testid": "assistant-needs-you-row" })[0]!
    .findAllByType("button");
  expect(staleButtons).toHaveLength(2);
  expect(staleButtons.every((button) => button.props.disabled)).toBe(true);

  // An empty but newer complete client snapshot is a tombstone for every old question on that machine.
  source.projects = [cp, { ...hometrace, assistant: { ...hometrace.assistant!, statuses: [] } }];
  source.sequences.set("macbook", 31);
  await update();
  assertCountAndRow(null);
  expect(renderedText(renderer.toJSON())).toContain("Some Projects could not be checked");
  expect(renderer.root.findAllByProps({ "data-testid": "assistant-needs-you-stale" })).toHaveLength(
    1,
  );

  // A recovered peer replaces its cached empty/old boards with its current source snapshot.
  const currentStatus = hometrace.assistant!.statuses![0]!;
  source.aggregate = {
    items: [
      {
        environmentId: hometrace.environmentId,
        projectId: hometrace.id,
        projectTitle: hometrace.title,
        machineLabel: "MacBook",
        coordinatorThreadId: hometrace.assistant!.coordinatorThreadId,
        status: { ...currentStatus, decision: currentStatus.decision! },
        stale: false,
      },
    ],
    machines: [
      { environmentId: cp.environmentId, label: "MacBook", state: "online", snapshotSequence: 32 },
    ],
  };
  await update();
  assertCountAndRow("Hometrace");
  expect(renderedText(renderer.toJSON())).not.toContain("Last known question");
  expect(renderedText(renderer.toJSON())).not.toContain("Some Projects could not be checked");
  expect(renderer.root.findAllByProps({ "data-testid": "assistant-needs-you-stale" })).toHaveLength(
    0,
  );
  await act(async () => renderer.unmount());
  registry.dispose();
});
