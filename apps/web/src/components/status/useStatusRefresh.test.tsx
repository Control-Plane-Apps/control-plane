import {
  type EnvironmentId,
  type ProjectStatus,
  STATUS_REFRESH_TIMEOUT_MS,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const env = vi.hoisted(() => ({ phase: "connected" as string }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: env.phase } }),
}));
import { type StatusRefresh, useStatusRefresh } from "./useStatusRefresh";

const environmentId = "env-1" as EnvironmentId;
const row = (id: string, updatedAt: string) => ({ id, updatedAt }) as unknown as ProjectStatus;

let latest: StatusRefresh;
let renderer: ReactTestRenderer;
function Probe(props: {
  statuses: ReadonlyArray<ProjectStatus>;
  send: () => boolean | Promise<boolean>;
}) {
  latest = useStatusRefresh({ environmentId, statuses: props.statuses, send: props.send });
  return null;
}
const mount = async (
  statuses: ReadonlyArray<ProjectStatus>,
  send: () => boolean | Promise<boolean>,
) => {
  await act(async () => {
    if (renderer === undefined) renderer = create(<Probe statuses={statuses} send={send} />);
    else renderer.update(<Probe statuses={statuses} send={send} />);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  env.phase = "connected";
  (renderer as ReactTestRenderer | undefined) = undefined as never;
});
afterEach(() => {
  vi.useRealTimers();
});

it("reads as asked until the board changes, and sends once for a double click", async () => {
  const send = vi.fn(async () => true);
  const board = [row("a", "t1")];
  await mount(board, send);
  await act(async () => {
    latest.request();
    latest.request();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(latest.asked).toBe(true);
  await act(async () => latest.request());
  expect(send).toHaveBeenCalledTimes(1);
  await mount([row("a", "t2")], send);
  expect(latest.asked).toBe(false);
});

it("gives up after the timeout", async () => {
  await mount([row("a", "t1")], async () => true);
  await act(async () => latest.request());
  expect(latest.asked).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(STATUS_REFRESH_TIMEOUT_MS + 1);
  });
  expect(latest.asked).toBe(false);
});

it("stays idle when the send is refused", async () => {
  await mount([row("a", "t1")], async () => false);
  await act(async () => latest.request());
  expect(latest.asked).toBe(false);
});

it("reports why it is blocked while the machine is away", async () => {
  env.phase = "offline";
  await mount([], async () => true);
  expect(latest.blockedReason).toMatch(/offline/);
  env.phase = "connected";
  await mount([], async () => true);
  expect(latest.blockedReason).toBeNull();
});
