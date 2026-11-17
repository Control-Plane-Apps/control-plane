import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/menu", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Menu: ({ open, children }: { open: boolean; children?: ReactNode }) => (
      <div data-open={open}>{children}</div>
    ),
    MenuGroup: Wrapper,
    MenuItem: Wrapper,
    MenuPopup: ({
      children,
      onKeyDownCapture,
    }: {
      children?: ReactNode;
      onKeyDownCapture: () => void;
    }) => (
      <div data-popup onKeyDownCapture={onKeyDownCapture}>
        {children}
      </div>
    ),
    MenuSeparator: () => null,
    MenuTrigger: Wrapper,
  };
});
const { TaskMoveMenu } = await import("./TaskMenus");
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
it("opens on each shortcut request and applies menu letter keys without expanding a row", async () => {
  vi.stubGlobal(
    "HTMLInputElement",
    class {
      readonly type = "date";
    },
  );
  const onMove = vi.fn();
  const menu = (openRequest: number) => (
    <TaskMoveMenu
      home={{ kind: "date", date: "2026-11-16" }}
      today="2026-11-16"
      openRequest={openRequest}
      onMove={onMove}
      onPickDate={vi.fn()}
    >
      Move
    </TaskMoveMenu>
  );
  await act(async () => {
    renderer = create(menu(0));
  });
  expect(renderer.root.findByProps({ "data-open": false })).toBeDefined();
  for (const [request, key, horizon] of [
    [1, "w", "week"],
    [2, "m", "month"],
    [3, "y", "year"],
  ] as const) {
    await act(async () => renderer.update(menu(request)));
    expect(renderer.root.findByProps({ "data-open": true })).toBeDefined();
    await act(async () =>
      renderer.root.findByProps({ "data-popup": true }).props.onKeyDownCapture({
        key,
        target: {},
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }),
    );
    expect(onMove).toHaveBeenLastCalledWith({ kind: "commit", horizon });
    expect(renderer.root.findByProps({ "data-open": false })).toBeDefined();
  }
});
