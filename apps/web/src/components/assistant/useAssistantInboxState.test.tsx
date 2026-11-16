import type { AssistantPing } from "@t3tools/client-runtime/state/assistant-home";
import { act, useCallback, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string, initial: string) => {
    const [values, setValues] = useState<Record<string, string>>({});
    const setValue = useCallback(
      (value: string) => setValues((previous) => ({ ...previous, [key]: value })),
      [key],
    );
    return [values[key] ?? initial, setValue];
  },
}));
import { useAssistantInboxState } from "./useAssistantInboxState";

it("marks pings read on opening, counts later pings and scopes reads to the thread", async () => {
  const ping = (createdAt: string): AssistantPing => ({
    activityId: createdAt,
    pingId: createdAt,
    createdAt,
    title: "Ping",
    body: "",
    actions: [],
  });
  let state!: ReturnType<typeof useAssistantInboxState>;
  function Harness({ pings, thread = "env:one" }: { pings: AssistantPing[]; thread?: string }) {
    const value = useAssistantInboxState(thread, pings);
    useLayoutEffect(() => {
      state = value;
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  const first = ping("2026-11-16T10:00:00Z");
  const second = ping("2026-11-16T11:00:00Z");
  await act(async () => {
    renderer = create(<Harness pings={[first]} />);
  });
  expect(state.unreadCount).toBe(1);
  await act(async () => state.onOpenChange(true));
  expect(state.unreadCount).toBe(0);
  await act(async () => renderer.update(<Harness pings={[second, first]} />));
  expect(state.unreadCount).toBe(1);
  await act(async () => state.onOpenChange(true));
  expect(state.unreadCount).toBe(0);
  await act(async () => state.onOpenChange(false));
  await act(async () =>
    renderer.update(<Harness pings={[ping("2026-11-16T12:00:00Z"), second, first]} />),
  );
  expect(state.unreadCount).toBe(1);
  await act(async () => renderer.update(<Harness pings={[first]} thread="env:two" />));
  expect(state.unreadCount).toBe(1);
  await act(async () => renderer.unmount());
});
