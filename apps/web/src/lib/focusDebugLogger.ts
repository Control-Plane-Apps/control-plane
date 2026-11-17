// Dev-only focus tracer. Records every change of document.activeElement plus
// the stack of any programmatic focus()/blur() call, so a focus steal can be
// traced back to the code that caused it.
//
// Enabled in dev builds, or in any build with localStorage["cp:debug-focus"]
// set to "1". Inspect `window.__cpFocusLog` (newest last) in DevTools.

import { isEditableElement } from "./editableElement";

const STORAGE_KEY = "cp:debug-focus";
const MAX_ENTRIES = 300;

export interface FocusLogEntry {
  readonly at: number;
  readonly kind:
    | "focusin"
    | "focusout"
    | "focus-call"
    | "blur-call"
    | "window-blur"
    | "window-focus"
    | "editable-removed";
  readonly target: string;
  readonly related: string | null;
  readonly editableLost: boolean;
  readonly stack: string | null;
}

declare global {
  interface Window {
    __cpFocusLog?: FocusLogEntry[];
  }
}

export function describeElement(element: EventTarget | null | undefined): string {
  if (!element) return "null";
  if (element === window) return "window";
  if (!(element instanceof Element)) return String(element);
  const parts = [element.tagName.toLowerCase()];
  if (element.id) parts.push(`#${element.id}`);
  const testId = element.getAttribute("data-testid");
  if (testId) parts.push(`[data-testid=${testId}]`);
  if (element.getAttribute("contenteditable") === "true") parts.push("[contenteditable]");
  const className = typeof element.className === "string" ? element.className : "";
  if (className) parts.push(`.${className.trim().split(/\s+/).slice(0, 3).join(".")}`);
  return parts.join("");
}

function shouldEnable(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let installed = false;

export function installFocusDebugLogger(): void {
  if (installed || typeof window === "undefined" || !shouldEnable()) return;
  installed = true;

  const log: FocusLogEntry[] = [];
  window.__cpFocusLog = log;
  let lastEditable: HTMLElement | null = null;

  const record = (entry: Omit<FocusLogEntry, "at">) => {
    const full = { ...entry, at: Date.now() };
    log.push(full);
    if (log.length > MAX_ENTRIES) log.shift();
    if (entry.editableLost) {
      console.warn("[focus-debug] editable lost focus", full);
    } else {
      console.debug("[focus-debug]", entry.kind, entry.target, entry.related ?? "");
    }
  };

  const proto = HTMLElement.prototype;
  const originalFocus = proto.focus;
  const originalBlur = proto.blur;
  proto.focus = function patchedFocus(this: HTMLElement, options?: FocusOptions) {
    const active = document.activeElement;
    record({
      kind: "focus-call",
      target: describeElement(this),
      related: describeElement(active),
      editableLost: isEditableElement(active) && active !== this && !active.contains(this),
      stack: new Error().stack ?? null,
    });
    return originalFocus.call(this, options);
  };
  proto.blur = function patchedBlur(this: HTMLElement) {
    record({
      kind: "blur-call",
      target: describeElement(this),
      related: null,
      editableLost: isEditableElement(this) && document.activeElement === this,
      stack: new Error().stack ?? null,
    });
    return originalBlur.call(this);
  };

  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as Element | null;
      if (isEditableElement(target)) lastEditable = target;
      record({
        kind: "focusin",
        target: describeElement(target),
        related: describeElement(event.relatedTarget),
        editableLost: false,
        stack: null,
      });
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (event) => {
      const target = event.target as Element | null;
      const editable = isEditableElement(target);
      // Resolve after the event: a null relatedTarget either means the window
      // lost focus (another webContents or app) or the node was removed.
      queueMicrotask(() => {
        record({
          kind: "focusout",
          target: `${describeElement(target)}${target && !target.isConnected ? " (detached)" : ""}`,
          related: `${describeElement(event.relatedTarget)} hasFocus=${document.hasFocus()}`,
          editableLost: editable && !isEditableElement(event.relatedTarget as Element | null),
          stack: new Error().stack ?? null,
        });
      });
    },
    true,
  );
  window.addEventListener("blur", () => {
    record({
      kind: "window-blur",
      target: "window",
      related: describeElement(document.activeElement),
      editableLost: isEditableElement(document.activeElement),
      stack: null,
    });
  });
  window.addEventListener("focus", () => {
    record({
      kind: "window-focus",
      target: "window",
      related: describeElement(document.activeElement),
      editableLost: false,
      stack: null,
    });
  });

  // Removing a focused node moves focus to <body> without a focusout in
  // Chromium. Catch that case: it means the editor was remounted.
  new MutationObserver(() => {
    if (lastEditable && !lastEditable.isConnected) {
      const lost = lastEditable;
      lastEditable = null;
      record({
        kind: "editable-removed",
        target: describeElement(lost),
        related: describeElement(document.activeElement),
        editableLost: true,
        stack: new Error().stack ?? null,
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
