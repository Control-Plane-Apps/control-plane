import { describe, expect, it } from "vite-plus/test";

import { shellListReadiness } from "./shellListReady";

const fresh = { shownBefore: false, settleExpired: false };

describe("shellListReadiness", () => {
  it("waits for the first cached shell", () => {
    expect(
      shellListReadiness({ hasLoadedShellSnapshot: false, hasPendingCachedShell: true }, fresh),
    ).toBe("waiting");
  });

  it("holds the first environment's rows while another is still reading its cache", () => {
    expect(
      shellListReadiness({ hasLoadedShellSnapshot: true, hasPendingCachedShell: true }, fresh),
    ).toBe("settling");
  });

  it("shows once every environment has read its cache", () => {
    expect(
      shellListReadiness({ hasLoadedShellSnapshot: true, hasPendingCachedShell: false }, fresh),
    ).toBe("ready");
  });

  it("shows what it has when the slow environment misses the settle window", () => {
    expect(
      shellListReadiness(
        { hasLoadedShellSnapshot: true, hasPendingCachedShell: true },
        { shownBefore: false, settleExpired: true },
      ),
    ).toBe("ready");
  });

  it("does not hold a list that has already shown for a newly added environment", () => {
    expect(
      shellListReadiness(
        { hasLoadedShellSnapshot: true, hasPendingCachedShell: true },
        { shownBefore: true, settleExpired: false },
      ),
    ).toBe("ready");
  });

  it("still falls back to the empty state when no snapshot is left", () => {
    expect(
      shellListReadiness(
        { hasLoadedShellSnapshot: false, hasPendingCachedShell: false },
        { shownBefore: true, settleExpired: true },
      ),
    ).toBe("waiting");
  });
});
