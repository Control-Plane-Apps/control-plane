import type { AssistantNeedsYouEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ reply: vi.fn() }));
vi.mock("~/state/server", () => ({ serverEnvironment: { assistantNeedsYouReply: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.reply }));
vi.mock("./useAssistant", () => ({
  useAssistantHomeEnvironment: () => ({ environmentId: "home" }),
}));
vi.mock("../ui/textarea", () => ({ Textarea: (props: object) => <textarea {...props} /> }));
import { AssistantRemoteNeedsYouRow } from "./AssistantRemoteNeedsYouRow";

const item = {
  environmentId: "unconnected",
  machineLabel: "Server only",
  projectId: "project",
  projectTitle: "Project",
  coordinatorThreadId: "coordinator",
  stale: false,
  status: {
    id: "question",
    title: "Status",
    state: "needs-you",
    summary: "",
    updatedAt: "2026-11-23T12:00:00.000Z",
    decision: {
      question: "Continue?",
      recommendation: "Continue",
      openedAt: "2026-11-23T12:00:00.000Z",
    },
  },
} as AssistantNeedsYouEntry;

it("routes recommendation through the Assistant home with exact question and coordinator identity", async () => {
  mocks.reply.mockResolvedValue({ _tag: "Success", value: { queued: true } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AssistantRemoteNeedsYouRow item={item} first />);
  });
  await act(async () => renderer.root.findAllByType("button")[0]!.props.onClick());
  expect(mocks.reply).toHaveBeenLastCalledWith({
    environmentId: "home",
    input: {
      environmentId: "unconnected",
      projectId: "project",
      coordinatorThreadId: "coordinator",
      statusId: "question",
      openedAt: item.status.decision.openedAt,
      text: "Go with your recommendation: Continue",
    },
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Answer queued");
  expect(renderer.root.findAllByType("button")[0]!.props.disabled).toBe(true);
  await act(async () => renderer.unmount());
});

it("keeps free text on failure and only reports success after a confirmed reply", async () => {
  mocks.reply.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Machine offline")),
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AssistantRemoteNeedsYouRow item={item} first />);
  });
  await act(async () => renderer.root.findAllByType("button")[1]!.props.onClick());
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "Please wait" } }),
  );
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.reply.mock.lastCall?.[0].input.text).toBe("Please wait");
  expect(renderer.root.findByType("textarea").props.value).toBe("Please wait");
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  expect(JSON.stringify(renderer.toJSON())).not.toContain("You answered");
  mocks.reply.mockResolvedValueOnce({ _tag: "Success", value: { queued: false } });
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(renderer.toJSON())).toContain("You answered");
  await act(async () => renderer.unmount());
});

it("shows stale questions without allowing an answer", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AssistantRemoteNeedsYouRow item={{ ...item, stale: true }} first />);
  });
  expect(renderer.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("Last known question");
  await act(async () => renderer.unmount());
});
