import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createAgentClickFocusGuard,
  type AgentClickFocusEnvironment,
  type FocusTarget,
} from "./agentClickFocusGuard";

const TAB = '["env","thread",null,"tab_1"]';

function pointer(
  phase: DesktopPreviewPointerEvent["phase"],
  tabId = TAB,
): DesktopPreviewPointerEvent {
  return { tabId, phase, x: 10, y: 10, sequence: 0, createdAt: "2026-11-17T00:00:00.000Z" };
}

/**
 * A tiny focus model: `active` is either an editable field, a button, or the
 * preview webview of a tab. Chromium focusing the guest on a dispatched mouse
 * press is modelled by setting `active` to that tab's webview.
 */
function makeEnvironment() {
  type Active =
    | { kind: "field"; field: FocusTarget }
    | { kind: "button" }
    | { kind: "webview"; tabId: string }
    | null;
  const state: { active: Active } = { active: null };
  const field = (): FocusTarget & { isConnected: boolean; focusCalls: number } => {
    const target = {
      isConnected: true,
      focusCalls: 0,
      focus: () => {
        target.focusCalls += 1;
        state.active = { kind: "field", field: target };
      },
    };
    return target;
  };
  const environment: AgentClickFocusEnvironment = {
    focusedEditable: () => (state.active?.kind === "field" ? state.active.field : null),
    previewWebviewFocused: (tabId) =>
      state.active?.kind === "webview" && state.active.tabId === tabId,
  };
  return { state, field, environment };
}

describe("createAgentClickFocusGuard", () => {
  it("hands focus back to the composer when an agent click pulls it into the webview", () => {
    const { state, field, environment } = makeEnvironment();
    const guard = createAgentClickFocusGuard(environment);
    const composer = field();
    composer.focus();

    guard.handle(pointer("move"));
    guard.handle(pointer("click"));
    state.active = { kind: "webview", tabId: TAB };
    guard.handle(pointer("release"));

    expect(state.active).toEqual({ kind: "field", field: composer });
  });

  it("leaves focus in the webview when no text field was focused before the click", () => {
    const { state, environment } = makeEnvironment();
    const guard = createAgentClickFocusGuard(environment);
    state.active = { kind: "button" };

    guard.handle(pointer("click"));
    state.active = { kind: "webview", tabId: TAB };
    guard.handle(pointer("release"));

    expect(state.active).toEqual({ kind: "webview", tabId: TAB });
  });

  it("does not undo focus the human moved elsewhere during the click", () => {
    const { state, field, environment } = makeEnvironment();
    const guard = createAgentClickFocusGuard(environment);
    const composer = field();
    composer.focus();

    guard.handle(pointer("click"));
    state.active = { kind: "button" };
    guard.handle(pointer("release"));

    expect(state.active).toEqual({ kind: "button" });
    expect(composer.focusCalls).toBe(1);
  });

  it("ignores focus taken by a different tab's webview", () => {
    const { state, field, environment } = makeEnvironment();
    const guard = createAgentClickFocusGuard(environment);
    const composer = field();
    composer.focus();

    guard.handle(pointer("click"));
    state.active = { kind: "webview", tabId: "other" };
    guard.handle(pointer("release"));

    expect(state.active).toEqual({ kind: "webview", tabId: "other" });
    expect(composer.focusCalls).toBe(1);
  });

  it("does not refocus a field that was removed meanwhile", () => {
    const { state, field, environment } = makeEnvironment();
    const guard = createAgentClickFocusGuard(environment);
    const composer = field();
    composer.focus();

    guard.handle(pointer("click"));
    composer.isConnected = false;
    state.active = { kind: "webview", tabId: TAB };
    guard.handle(pointer("release"));

    expect(composer.focusCalls).toBe(1);
  });

  it("only acts once per click: a later release without a click is ignored", () => {
    const { state, field, environment } = makeEnvironment();
    const guard = createAgentClickFocusGuard(environment);
    const composer = field();
    composer.focus();

    guard.handle(pointer("click"));
    state.active = { kind: "webview", tabId: TAB };
    guard.handle(pointer("release"));
    // The human now clicks into the page themselves.
    state.active = { kind: "webview", tabId: TAB };
    guard.handle(pointer("release"));

    expect(state.active).toEqual({ kind: "webview", tabId: TAB });
    expect(composer.focusCalls).toBe(2);
  });
});
