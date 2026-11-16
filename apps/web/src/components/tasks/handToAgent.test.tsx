import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { Task } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setPrompt: vi.fn(),
  handOff: vi.fn(async () => true),
  newThread: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setPrompt: mocks.setPrompt, send: mocks.send }) },
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.newThread }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../state/tasks", () => ({ useTasks: () => ({ environmentId: "env", tasks: [] }) }));
vi.mock("./useTaskActions", () => ({ useTaskActions: () => ({ handOff: mocks.handOff }) }));

import { useHandToAgent } from "./handToAgent";

let renderer: ReactTestRenderer;
let handToAgent: ReturnType<typeof useHandToAgent>;
function Probe() {
  const action = useHandToAgent();
  useEffect(() => {
    handToAgent = action;
  }, [action]);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("prepares one combined coordinator draft and links every selected task without sending", async () => {
  const tasks = [
    { id: "task-a", title: "Review synthetic task A", notes: "First task context" },
    { id: "task-b", title: "Review synthetic task B", notes: "Second task context" },
  ] as unknown as Task[];
  const project = {
    id: "project",
    environmentId: "env",
    assistant: { coordinatorThreadId: "coordinator" },
  } as unknown as EnvironmentProject;
  await act(async () => {
    await handToAgent(tasks, "coordinator", project);
  });
  expect(mocks.setPrompt).toHaveBeenCalledOnce();
  const prompt = mocks.setPrompt.mock.calls[0]?.[1];
  expect(prompt).toContain(tasks[0]!.title);
  expect(prompt).toContain(tasks[1]!.title);
  expect(prompt).toContain("First task context");
  expect(prompt).toContain("Second task context");
  expect(mocks.handOff).toHaveBeenCalledTimes(2);
  for (const task of tasks) {
    expect(mocks.handOff).toHaveBeenCalledWith(task, {
      kind: "coordinator",
      threadId: "coordinator",
      at: expect.any(String),
    });
  }
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(mocks.newThread).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
