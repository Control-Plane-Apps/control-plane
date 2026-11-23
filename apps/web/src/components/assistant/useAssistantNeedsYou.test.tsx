import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const source = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  reach: null as string[] | null,
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
  useOpenAssistant: () => ({ open: vi.fn(), opening: false }),
  useSendToThread: () => vi.fn(),
  useAssistantHomeEnvironment: () => ({
    serverConfig: { settings: { assistant: { projects: source.reach } } },
  }),
}));
import { useAssistantNeedsYou } from "./useAssistantNeedsYou";
import { SidebarAssistantRow } from "./SidebarAssistantRow";
import { AssistantOverview } from "./AssistantOverview";

it("shares the list and count across servers using the Assistant home's reach", async () => {
  const project = (id: string, environmentId: string) =>
    ({
      id,
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
  source.reach = ["control-plane"];
  let badge = 0;
  let rows: ReturnType<typeof useAssistantNeedsYou> = [];
  function Harness() {
    badge = useAssistantNeedsYou().length;
    rows = useAssistantNeedsYou();
    return (
      <>
        <SidebarAssistantRow isActive />
        <AssistantOverview
          assistant={{ assistant: { statuses: [] } } as unknown as EnvironmentProject}
          needsYou={rows}
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
  expect(badge).toBe(1);
  assertConsumersAgree(1);
  expect(rows.map((row) => row.project.environmentId)).toEqual(["macbook"]);
  source.reach = null;
  await act(async () => renderer.update(<Harness />));
  expect(badge).toBe(2);
  assertConsumersAgree(2);
  expect(badge).toBe(rows.length);
  source.reach = [];
  await act(async () => renderer.update(<Harness />));
  expect(badge).toBe(0);
  assertConsumersAgree(0);
  expect(rows).toEqual([]);
  await act(async () => renderer.unmount());
});
