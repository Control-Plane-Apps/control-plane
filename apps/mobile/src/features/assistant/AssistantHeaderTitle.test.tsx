import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: "div" }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("./AssistantMark", () => ({ AssistantMark: () => <i data-testid="mark" /> }));

import { AssistantHeaderTitle } from "./AssistantHeaderTitle";

describe("AssistantHeaderTitle", () => {
  it("shows just the mark and Assistant, with no channel switcher", () => {
    const markup = renderToStaticMarkup(<AssistantHeaderTitle />);
    expect(markup).toContain("Assistant");
    expect(markup).not.toContain("Today");
  });
});
