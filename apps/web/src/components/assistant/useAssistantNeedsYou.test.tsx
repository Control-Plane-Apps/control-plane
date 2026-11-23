import { EnvironmentId, type AssistantNeedsYouResult } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const source = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  reach: null as string[] | null,
  homePhase: "connected",
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
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map(["macbook", "mini"].map((id) => [id, { connection: { phase: "connected" } }])),
      ),
    },
  };
});
vi.mock("~/state/shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const live = Atom.make({ status: "live" });
  return { environmentShell: { stateValueAtom: () => live } };
});
vi.mock("~/state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const aggregate = Atom.make(() => AsyncResult.success(source.aggregate));
  return { serverEnvironment: { assistantNeedsYou: () => aggregate, assistantNeedsYouReply: {} } };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/environments", () => ({
  useEnvironment: (id: string) =>
    id === "server-only" ? null : { connection: { phase: "connected" } },
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
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
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
  expect(JSON.stringify(renderer.toJSON())).toContain("control-plane");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("other");
  expect(JSON.stringify(renderer.toJSON())).toContain("Unconnected server");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Could not check Direct MacBook");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Home cannot reach it");
  source.reach = null;
  await act(async () => renderer.update(<Harness />));
  assertConsumersAgree(3);
  source.homePhase = "reconnecting";
  await act(async () => renderer.update(<Harness />));
  assertConsumersAgree(3);
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Could not refresh questions from the Assistant",
  );
  expect(JSON.stringify(renderer.toJSON())).toContain("Last known question, machine unavailable");
  expect(renderer.root.findAllByType("button").some((button) => button.props.disabled)).toBe(true);
  source.homePhase = "connected";
  source.reach = [];
  await act(async () => renderer.update(<Harness />));
  assertConsumersAgree(0);
  await act(async () => renderer.unmount());
});
