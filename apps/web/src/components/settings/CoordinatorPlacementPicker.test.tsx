import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { CoordinatorPlacementPicker } from "./CoordinatorPlacementPicker";

type Run = ComponentProps<typeof CoordinatorPlacementPicker>["run"];
type Status = Awaited<ReturnType<Run>>;
const idle: Status = { phase: "idle", ownerId: "local", ready: false, detail: "Running here." };
const source = {
  projectId: "synthetic-project",
  title: "Source",
  workspaceRoot: "/registered/source",
  repository: "example/repo",
};
const target = {
  projectId: "destination-project",
  title: "Target",
  workspaceRoot: "/registered/target",
  repository: "example/repo",
};
const inventory: Status = { ...idle, sourceCheckouts: [source], destinationProjects: [target] };
const checkedIds = {
  sourceCheckoutProjectId: source.projectId,
  destinationProjectId: target.projectId,
};
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
        projectId={source.projectId}
        machines={[{ id: "peer", label: "Destination" }]}
        run={run}
      />,
    );
  });
}
async function select(label: string, value: string) {
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": label })
      .props.onChange({ currentTarget: { value } }),
  );
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
    .mockResolvedValueOnce(inventory)
    .mockResolvedValueOnce({ ...idle, detail: "Checkout unavailable." })
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "reviewed" })
    .mockResolvedValueOnce(paused);
  await render(run);
  await select("Coordinator runs on", "peer");
  expect(run.mock.calls).toEqual([
    [{ operation: "status" }],
    [{ operation: "options", destinationId: "peer" }],
    [{ operation: "preflight", destinationId: "peer", ...checkedIds }],
  ]);
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  await click("Check again");
  expect(run).toHaveBeenCalledTimes(4);
  await click("Move coordinator to Destination");
  expect(run).toHaveBeenLastCalledWith({
    operation: "move",
    destinationId: "peer",
    ...checkedIds,
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
    .mockResolvedValueOnce(inventory)
    .mockResolvedValueOnce({ ...idle, ready: true })
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "first" })
    .mockRejectedValueOnce(new Error("Project changed. Review preflight again."))
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce(inventory)
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "second" })
    .mockResolvedValueOnce(paused);
  const selectPeer = async () => select("Coordinator runs on", "peer");
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
  expect(run).toHaveBeenLastCalledWith({
    operation: "preflight",
    destinationId: "peer",
    ...checkedIds,
  });
  await click("Move coordinator to Destination");
  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: "move", approvalDigest: "second" }),
  );
  const moves = run.mock.calls.flatMap(([request]) =>
    request.operation === "move" ? [request] : [],
  );
  expect(moves[0]?.moveId).not.toBe(moves[1]?.moveId);
});

it("binds the chosen registered source and destination to the review and shows ineligible destinations", async () => {
  const alternate = {
    ...source,
    projectId: "other-source",
    workspaceRoot: "/workspace/alternate",
    repository: "example/other",
  };
  const first = {
    ...target,
    projectId: "target-one",
    workspaceRoot: "/linked/one",
    repository: alternate.repository,
  };
  const second = { ...first, projectId: "target-two", workspaceRoot: "/linked/two" };
  const blocked = {
    ...first,
    projectId: "target-used",
    title: "Existing Project",
    workspaceRoot: "/linked/used",
    blockedReason: "This Project already has threads.",
  };
  const choices = {
    ...inventory,
    sourceCheckouts: [source, alternate],
    destinationProjects: [target, first, second, blocked],
  };
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce(choices)
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "original" })
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "chosen" })
    .mockResolvedValueOnce(paused);
  await render(run);
  await select("Coordinator runs on", "peer");
  expect(run).toHaveBeenLastCalledWith({
    operation: "preflight",
    destinationId: "peer",
    ...checkedIds,
  });
  await select("Source checkout", alternate.projectId);
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  expect(renderer!.root.findByProps({ "aria-label": "Destination Project" }).props.value).toBe("");
  expect(renderer!.root.findByProps({ value: blocked.projectId }).props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain(blocked.blockedReason);
  await select("Destination Project", second.projectId);
  const approval = {
    destinationId: "peer",
    sourceCheckoutProjectId: alternate.projectId,
    destinationProjectId: second.projectId,
  };
  expect(run).toHaveBeenLastCalledWith({ operation: "preflight", ...approval });
  await click("Move coordinator to Destination");
  expect(run).toHaveBeenLastCalledWith({
    operation: "move",
    ...approval,
    approvalDigest: "chosen",
    moveId: expect.any(String),
  });
});

it("lets a coordinator without a registered source choose a checkout and distinguishes an unavailable destination", async () => {
  const second = { ...source, projectId: "second" };
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce({
      ...inventory,
      sourceCheckouts: [second],
      destinationProjects: [],
    });
  await render(run);
  await select("Coordinator runs on", "peer");
  expect(renderer!.root.findByProps({ "aria-label": "Source checkout" }).props.value).toBe("");
  await select("Source checkout", second.projectId);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Register an empty Project");
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  expect(run).toHaveBeenCalledTimes(2);
});

it("shows a blocked source reason and never preflights its matching destination", async () => {
  const blocked = { ...source, blockedReason: "This checkout overlaps the coordinator workspace." };
  const alternate = { ...source, projectId: "alternate", workspaceRoot: "/registered/alternate" };
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce({ ...inventory, sourceCheckouts: [blocked, alternate] })
    .mockResolvedValueOnce({ ...idle, ready: true, approvalDigest: "alternate" });
  await render(run);
  await select("Coordinator runs on", "peer");
  expect(renderer!.root.findByProps({ "aria-label": "Source checkout" }).props.value).toBe("");
  expect(renderer!.root.findByProps({ value: blocked.projectId }).props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain(blocked.blockedReason);
  await select("Source checkout", blocked.projectId);
  expect(run).toHaveBeenCalledTimes(2);
  await select("Source checkout", alternate.projectId);
  expect(run).toHaveBeenLastCalledWith({
    operation: "preflight",
    destinationId: "peer",
    sourceCheckoutProjectId: alternate.projectId,
    destinationProjectId: target.projectId,
  });
});

it("explains how to recover when a peer cannot list registered checkout choices", async () => {
  const run = vi
    .fn<Run>()
    .mockResolvedValueOnce(idle)
    .mockRejectedValueOnce(new Error("Unknown operation."));
  await render(run);
  await select("Coordinator runs on", "peer");
  expect(JSON.stringify(renderer!.toJSON())).toContain("update both environments");
  expect(buttons("Move coordinator to Destination")).toHaveLength(0);
  expect(run).toHaveBeenCalledTimes(2);
});
