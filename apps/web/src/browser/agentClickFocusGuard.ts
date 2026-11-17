import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";

import { isEditableElement } from "~/lib/editableElement";

/**
 * Agents drive preview browsers in the background, including browsers of
 * threads the human is not looking at. A dispatched agent click makes
 * Chromium focus the guest page, which moves the host's focus onto the
 * `<webview>` element and silently takes the keyboard away from whatever the
 * human was typing in.
 *
 * The guard remembers the focused text field when an agent click starts
 * (`click`) and, once the click's mouse events were dispatched (`release`),
 * hands focus back to that field if the click's own webview now holds it.
 * Only agent clicks produce these events, so a human clicking into a preview
 * keeps focus there.
 */
export interface AgentClickFocusGuard {
  readonly handle: (event: DesktopPreviewPointerEvent) => void;
}

export interface FocusTarget {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
}

export interface AgentClickFocusEnvironment {
  /** The focused element when it takes typed text, otherwise null. */
  readonly focusedEditable: () => FocusTarget | null;
  /** True while the preview webview of `tabId` holds focus. */
  readonly previewWebviewFocused: (tabId: string) => boolean;
}

export const documentFocusEnvironment: AgentClickFocusEnvironment = {
  focusedEditable: () => {
    const active = document.activeElement;
    return isEditableElement(active) ? active : null;
  },
  previewWebviewFocused: (tabId) => {
    const active = document.activeElement;
    return (
      active?.tagName.toLowerCase() === "webview" &&
      active.getAttribute("data-preview-tab") === tabId
    );
  },
};

export function createAgentClickFocusGuard(
  environment: AgentClickFocusEnvironment = documentFocusEnvironment,
): AgentClickFocusGuard {
  const protectedByTab = new Map<string, FocusTarget>();
  return {
    handle: (event) => {
      if (event.phase === "move") return;
      if (event.phase === "click") {
        const editable = environment.focusedEditable();
        if (editable) {
          protectedByTab.set(event.tabId, editable);
        } else {
          protectedByTab.delete(event.tabId);
        }
        return;
      }
      const target = protectedByTab.get(event.tabId);
      protectedByTab.delete(event.tabId);
      if (!target || !target.isConnected) return;
      // Hand focus back only when the click's own webview took it. Anything
      // else means the click left focus alone or the human moved it.
      if (!environment.previewWebviewFocused(event.tabId)) return;
      target.focus({ preventScroll: true });
    },
  };
}
