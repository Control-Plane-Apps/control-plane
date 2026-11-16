import { act, type ReactNode, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { TaskSyncStatus } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", async () => {
  const React = await import("react");
  const Context = React.createContext({ open: false, toggle: () => {} });
  return {
    Popover: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      const toggle = React.useCallback(() => setOpen((current) => !current), []);
      const value = React.useMemo(() => ({ open, toggle }), [open, toggle]);
      return <Context.Provider value={value}>{children}</Context.Provider>;
    },
    PopoverTrigger: ({ children, ...props }: ComponentProps<"button">) => {
      const context = React.useContext(Context);
      return (
        <button {...props} onClick={context.toggle}>
          {children}
        </button>
      );
    },
    PopoverPopup: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(Context);
      return open ? <section data-testid="sync-popover">{children}</section> : null;
    },
    PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    PopoverDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
const { TaskSyncChip, taskSyncIndicator } = await import("./TaskSyncIndicator");
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer.unmount()));
const status = (state: TaskSyncStatus["state"], pendingChanges = 0) =>
  ({ state, pendingChanges }) as TaskSyncStatus;

describe("Task Sync header", () => {
  const states: Array<[TaskSyncStatus | null, string]> = [
    [null, "On this Mac"],
    [status("unavailable"), "On this Mac"],
    [status("signed-out"), "On this Mac"],
    [status("inactive"), "On this Mac"],
    [status("coming-soon"), "On this Mac"],
    [status("syncing"), "Syncing"],
    [status("synced"), "Synced"],
    [status("error", 3), "Offline · 3 waiting"],
    [status("error"), "Offline"],
  ];
  it.each(states)("keeps %j visible in the header as %s", async (syncStatus, label) => {
    await act(async () => {
      renderer = create(<TaskSyncChip indicator={taskSyncIndicator(syncStatus)} />);
    });
    const trigger = renderer.root.findByType("button");
    expect(trigger.props["aria-label"]).toBe(`Task Sync: ${label}`);
    expect(trigger.children).toContain(label);
    expect(renderer.root.findAllByType("a")).toHaveLength(0);
  });

  it.each(["signed-out", "inactive"] as const)(
    "puts the %s subscription prompt inside the popover",
    async (state) => {
      await act(async () => {
        renderer = create(<TaskSyncChip indicator={taskSyncIndicator(status(state))} />);
      });
      expect(renderer.root.findAllByType("a")).toHaveLength(0);
      await act(async () => renderer.root.findByType("button").props.onClick());
      const action = renderer.root.findByType("a");
      expect(action.props.href).toBe("/settings/task-sync");
      expect(action.children).toEqual(["Turn on · $5/month"]);
      expect(renderer.root.findByProps({ "data-testid": "sync-popover" }).findByType("a")).toBe(
        action,
      );
    },
  );

  it("keeps waiting detail and settings available from the offline header", async () => {
    await act(async () => {
      renderer = create(<TaskSyncChip indicator={taskSyncIndicator(status("error", 2))} />);
    });
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(renderer.root.findAllByType("p").map((node) => node.children.join(""))).toEqual([
      "Offline",
      "2 changes waiting",
    ]);
    expect(renderer.root.findByType("a").children).toEqual(["Task Sync settings"]);
  });
});
