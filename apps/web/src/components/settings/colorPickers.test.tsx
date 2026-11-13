import { act, type ReactNode, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Render popover content without portals so these tests exercise picker input
// and persistence behavior without starting a browser.
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: () => null,
  PopoverClose: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

let renderer: ReactTestRenderer | undefined;
let nextFrameId = 0;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  frames.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function slider(label: string) {
  return renderer!.root.find(
    (node) =>
      (node.props.role === "slider" || node.props.type === "range") &&
      node.props["aria-label"] === label,
  );
}

async function key(label: string, key: string, shiftKey = false) {
  const preventDefault = vi.fn();
  await act(async () => slider(label).props.onKeyDown({ key, shiftKey, preventDefault }));
  return preventDefault;
}

describe("shared color controls in settings", () => {
  it("adjusts each provider color axis independently and reports the value being changed", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      renderer = create(
        <ProviderAccentColorPicker displayName="Codex" value="#ff0000" onCommit={onCommit} />,
      );
    });
    const hue = "Accent color hue";
    const saturation = "Accent color saturation";
    const brightness = "Accent color brightness";
    expect(await key(hue, "ArrowLeft")).toHaveBeenCalledOnce();
    expect(slider(hue).props["aria-valuenow"]).toBe(359);
    await key(hue, "ArrowRight");
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");
    await key(saturation, "ArrowRight", true);
    await key(brightness, "ArrowUp", true);
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");
    await key(brightness, "ArrowDown", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e60000");
    expect(slider(brightness).props.value).toBe(90);
    expect(slider(brightness).props["aria-valuetext"]).toBe("90%");
    expect(slider(saturation).props.value).toBe(100);
    // Up/Down on saturation must adjust the reported saturation, not brightness.
    await key(saturation, "ArrowDown", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e61717");
    expect(slider(saturation).props.value).toBe(90);
    expect(slider(saturation).props["aria-valuetext"]).toBe("90%");
    await key(saturation, "ArrowUp", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e60000");
    // Left/Right on brightness must likewise leave saturation unchanged.
    await key(brightness, "ArrowLeft", true);
    expect(onCommit).toHaveBeenLastCalledWith("#cc0000");
    await key(brightness, "ArrowRight", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e60000");
    onCommit.mockClear();
    expect(await key(saturation, "Tab")).not.toHaveBeenCalled();
    expect(await key(brightness, "Tab")).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("supports Home/End and clamps each axis without changing the other", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      renderer = create(
        <ProviderAccentColorPicker displayName="Codex" value="#ff0000" onCommit={onCommit} />,
      );
    });
    const saturation = "Accent color saturation";
    const brightness = "Accent color brightness";
    await key(saturation, "Home");
    await key(saturation, "ArrowLeft");
    expect(slider(saturation).props.value).toBe(0);
    expect(onCommit).toHaveBeenLastCalledWith("#ffffff");
    await key(brightness, "Home");
    await key(brightness, "ArrowDown");
    expect(slider(brightness).props.value).toBe(0);
    expect(onCommit).toHaveBeenLastCalledWith("#000000");
    await key(saturation, "End");
    expect(slider(saturation).props.value).toBe(100);
    expect(slider(brightness).props.value).toBe(0);
    await key(brightness, "End");
    await key(brightness, "ArrowUp");
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");
    await key(saturation, "ArrowLeft");
    expect(slider(saturation).props.value).toBe(98);
    expect(onCommit).toHaveBeenLastCalledWith("#ff0505");
  });

  it("keeps provider debounce at the consumer and commits pending color on unmount", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    await act(async () => {
      renderer = create(
        <ProviderAccentColorPicker
          displayName="Codex"
          value="#ff0000"
          onCommit={onCommit}
          commitDelayMs={250}
        />,
      );
    });
    const hue = "Accent color hue";
    await key(hue, "ArrowRight", true);
    await key(hue, "ArrowRight", true);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(250));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("#ff5500");
    await key(hue, "ArrowRight", true);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(onCommit).toHaveBeenLastCalledWith("#ff8000");
    await act(async () => vi.advanceTimersByTime(250));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
