import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AssistantHeader, newChannelTitle } from "./AssistantHeader";

const noop = () => undefined;

describe("AssistantHeader", () => {
  it("keeps the new channel field out of the bar until + is clicked", () => {
    const html = renderToStaticMarkup(
      <AssistantHeader
        subtitle="Across 3 Projects"
        channels={[{ id: "today", label: "Today" }]}
        selected="today"
        inboxCount={0}
        onSelect={noop}
        onCreateChannel={noop}
        onOpenMemory={noop}
        onOpenSettings={noop}
        rightPanelOpen={false}
      />,
    );
    expect(html).toContain('aria-label="New channel"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Channel name");
  });
});

describe("AssistantHeader schedules", () => {
  const render = (onOpenSchedules?: () => void) =>
    renderToStaticMarkup(
      <AssistantHeader
        subtitle=""
        channels={[]}
        selected="today"
        inboxCount={0}
        onSelect={noop}
        onCreateChannel={noop}
        onOpenMemory={noop}
        onOpenSchedules={onOpenSchedules}
        onOpenSettings={noop}
        rightPanelOpen
      />,
    );

  it("shows Schedules only when the server stores schedules", () => {
    expect(render(noop)).toContain('aria-label="Schedules"');
    expect(render()).not.toContain('aria-label="Schedules"');
  });
});

describe("newChannelTitle", () => {
  it("trims the name and refuses a blank one", () => {
    expect(newChannelTitle("  Weekly review ")).toBe("Weekly review");
    expect(newChannelTitle("   ")).toBeNull();
    expect(newChannelTitle("")).toBeNull();
  });
});
