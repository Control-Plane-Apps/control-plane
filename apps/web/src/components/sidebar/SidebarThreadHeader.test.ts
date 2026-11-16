import { describe, expect, it } from "vite-plus/test";

import { isSidebarSearchFieldVisible, sidebarActionTooltip } from "./SidebarThreadHeader";

describe("sidebar title bar actions", () => {
  it("labels an icon with its shortcut when it has one", () => {
    expect(sidebarActionTooltip("New Chat", "⌘N")).toBe("New Chat (⌘N)");
    expect(sidebarActionTooltip("Search", null)).toBe("Search");
  });

  it("shows the search field while opened or holding a query", () => {
    expect(isSidebarSearchFieldVisible(false, "")).toBe(false);
    expect(isSidebarSearchFieldVisible(true, "")).toBe(true);
    expect(isSidebarSearchFieldVisible(false, "pay")).toBe(true);
  });
});
