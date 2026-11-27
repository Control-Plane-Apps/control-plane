import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { CoordinatorPlacementPicker } from "./CoordinatorPlacementPicker";

type Run = ComponentProps<typeof CoordinatorPlacementPicker>["run"];
type Status = Awaited<ReturnType<Run>>;
const idle: Status = { phase: "idle", ownerId: "local", ready: false, detail: "Running here." };
const paused: Status = {
  ...idle,
  phase: "staging",
  moveId: "receipt",
  destinationId: "peer",
  detail: "Verification pending.",
};

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function render(run: Run) {
  await act(async () => {
    renderer = create(
      <CoordinatorPlacementPicker
        localLabel="Source"
        projectKey="synthetic-project"
        machines={[{ id: "peer", label: "Destination" }]}
        run={run}
      />,
    );
  });
}
function buttons(label: string) {
  return renderer!.root.findAllByType("button").filter((node) => node.children.join("") === label);
}
async function click(label: string) {
  const matches = buttons(label);
  expect(matches).toHaveLength(1);
  await act(async () => matches[0]!.props.onClick());
}

it("requires a ready preflight and explicit approval before issuing the first move", async () => {
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce({ ...idle, detail: "Checkout unavailable." })
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "reviewed" })
    .mockResolvedValueOnce(paused);
  await render(run);
  await act(async () =>
    renderer!.root.findByType("select").props.onChange({ currentTarget: { value: "peer" } }),
  );
  expect(run.mock.calls).toEqual([
    [{ operation: "status" }],
    [{ operation: "preflight", destinationId: "peer" }],
  ]);
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  await click("Check again");
  expect(run).toHaveBeenCalledTimes(3);
  await click("Move coordinator to Destination");
  expect(run).toHaveBeenLastCalledWith({
    operation: "move",
    destinationId: "peer",
    moveId: expect.any(String),
    approvalDigest: "reviewed",
  });
  expect(renderer!.root.findAllByType("select")).toHaveLength(0);
});

it("recovers from a lost retry response using the source receipt, then confirms rollback separately", async () => {
  const active = { ...paused, phase: "active", ownerId: "peer" };
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(paused)
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce({ ...idle, phase: "rolled-back" });
  await render(run);
  await click("Retry verification");
  expect(run).toHaveBeenLastCalledWith({ operation: "retry", moveId: "receipt" });
  expect(buttons("Roll back move")).toHaveLength(0);
  await click("Refresh status");
  await click("Roll back move");
  expect(run).toHaveBeenCalledTimes(3);
  await click("Confirm rollback");
  expect(run).toHaveBeenLastCalledWith({ operation: "rollback", moveId: "receipt" });
  expect(renderer!.root.findAllByType("select")).toHaveLength(1);
});

it("keeps transition controls on the original machine", async () => {
  await render(vi.fn<Run>().mockResolvedValue({ ...paused, incoming: true }));
  expect(buttons("Retry verification")).toHaveLength(0);
  expect(buttons("Roll back move")).toHaveLength(0);
  expect(buttons("Refresh status")).toHaveLength(1);
});

it("requires another review and approval when the proposal changes", async () => {
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce({ ...idle, ready: true })
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "first" })
    .mockRejectedValueOnce(new Error("Project changed. Review preflight again."))
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "second" })
    .mockResolvedValueOnce(paused);
  const selectPeer = async () =>
    act(async () =>
      renderer!.root.findByType("select").props.onChange({ currentTarget: { value: "peer" } }),
    );
  await render(run);
  await selectPeer();
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  await click("Check again");
  await click("Move coordinator to Destination");
  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: "move", approvalDigest: "first" }),
  );
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  await click("Refresh status");
  await selectPeer();
  expect(run).toHaveBeenLastCalledWith({ operation: "preflight", destinationId: "peer" });
  await click("Move coordinator to Destination");
  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: "move", approvalDigest: "second" }),
  );
  const moves = run.mock.calls.flatMap(([request]) =>
    request.operation === "move" ? [request] : [],
  );
  expect(moves[0]?.moveId).not.toBe(moves[1]?.moveId);
});
