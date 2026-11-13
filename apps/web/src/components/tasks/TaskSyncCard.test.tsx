import type { TaskSyncStatus } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

let current: TaskSyncStatus | null = null;
vi.mock("../../state/taskSync", () => ({
  useTaskSync: () => ({
    status: current,
    busy: false,
    requestCode: vi.fn(),
    verify: vi.fn(),
    signOut: vi.fn(),
    syncNow: vi.fn(),
    openCheckout: vi.fn(),
    openPortal: vi.fn(),
  }),
}));

const { TaskSyncCard } = await import("./TaskSyncCard");

const base = { pendingChanges: 0, weekStartsOn: 1 } as const;

describe("TaskSyncCard", () => {
  it("shows coming soon with no sign-in or Subscribe while the service has Task Sync off", () => {
    current = { state: "coming-soon", ...base };
    const html = renderToStaticMarkup(<TaskSyncCard />);
    expect(html).toContain("Task Sync is coming soon");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("Subscribe");
    // The Tasks page stays quiet.
    expect(renderToStaticMarkup(<TaskSyncCard compact />)).toBe("");
  });

  it("offers sign-in once the service switches Task Sync on", () => {
    current = { state: "signed-out", ...base };
    const html = renderToStaticMarkup(<TaskSyncCard />);
    expect(html).toContain("Sign in to sync tasks");
    expect(html).toContain('type="email"');
    expect(html).not.toContain("coming soon");
  });
});
