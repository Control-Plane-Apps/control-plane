import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { Task } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  handOff: vi.fn(async (_task: unknown, _handoff: unknown, _delivery?: unknown) => true),
  toast: vi.fn(),
  projects: [] as unknown[],
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/tasks", () => ({ useTasks: () => ({ environmentId: "env", tasks: [] }) }));
vi.mock("./useTaskActions", () => ({ useTaskActions: () => ({ handOff: mocks.handOff }) }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "uuid-1" }));

import { useHandToAssistant } from "./handToAssistant";

const ASSISTANT = {
  id: "assistant-home",
  environmentId: "env",
  assistant: { coordinatorThreadId: "assistant-today", scope: "global" },
};

let renderer: ReactTestRenderer;
let handToAssistant: ReturnType<typeof useHandToAssistant>;
function Probe() {
  const action = useHandToAssistant();
  useEffect(() => {
    handToAssistant = action;
  }, [action]);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.projects = [ASSISTANT];
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const tasks = [
  { id: "task-a", title: "Review synthetic task A" },
  { id: "task-b", title: "Review synthetic task B" },
] as unknown as Task[];

it("links every selected task to the Assistant and sends them once, on the last", async () => {
  await act(async () => {
    expect(await handToAssistant(tasks)).toBe(true);
  });
  expect(mocks.handOff).toHaveBeenCalledTimes(2);
  const handoff = { kind: "coordinator", threadId: "assistant-today", at: expect.any(String) };
  expect(mocks.handOff).toHaveBeenNthCalledWith(1, tasks[0], handoff, undefined);
  expect(mocks.handOff).toHaveBeenNthCalledWith(2, tasks[1], handoff, {
    commandId: "cp-send:assistant-today:task-handoff:uuid-1",
    taskIds: ["task-a", "task-b"],
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", title: "Handed 2 tasks to Assistant" }),
  );
});

it("sends nothing when a link fails, or when there is no Assistant", async () => {
  mocks.handOff.mockImplementationOnce(async () => false);
  await act(async () => {
    expect(await handToAssistant(tasks)).toBe(false);
  });
  expect(mocks.handOff).toHaveBeenCalledOnce();
  expect(mocks.toast).not.toHaveBeenCalled();

  mocks.handOff.mockClear();
  mocks.projects = [];
  act(() => renderer.update(<Probe />));
  await act(async () => {
    expect(await handToAssistant(tasks[0]!)).toBe(false);
  });
  expect(mocks.handOff).not.toHaveBeenCalled();
});
