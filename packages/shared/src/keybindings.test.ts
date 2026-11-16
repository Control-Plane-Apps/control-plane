import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  THREAD_JUMP_DEFAULT_KEY_COUNT,
} from "./keybindings.ts";

const keyOf = (command: string, when?: string) =>
  DEFAULT_KEYBINDINGS.find(
    (rule) => rule.command === command && (when === undefined || rule.when === when),
  )?.key;

describe("default keybindings", () => {
  it("opens the Assistant on mod+1 and Tasks on mod+2", () => {
    expect(keyOf("assistant.open")).toBe("mod+1");
    expect(keyOf("tasks.open")).toBe("mod+2");
  });

  it("starts the thread jumps at mod+3, for the first seven threads", () => {
    expect(THREAD_JUMP_DEFAULT_KEY_COUNT).toBe(7);
    for (let thread = 1; thread <= 7; thread += 1) {
      expect(keyOf(`thread.jump.${thread}`)).toBe(`mod+${thread + 2}`);
    }
    expect(keyOf("thread.jump.8")).toBeUndefined();
    expect(keyOf("thread.jump.9")).toBeUndefined();
  });

  it("puts the Tasks range tabs on ctrl+1..6 on a Mac and alt+1..6 elsewhere", () => {
    const ranges = ["today", "week", "month", "year", "upcoming", "all"];
    ranges.forEach((range, index) => {
      expect(keyOf(`tasks.range.${range}`, "isDesktop && isMac")).toBe(`ctrl+${index + 1}`);
      expect(keyOf(`tasks.range.${range}`, "isDesktop && !isMac")).toBe(`alt+${index + 1}`);
    });
  });

  it("never gives two commands the same key in the same context", () => {
    const claims = DEFAULT_KEYBINDINGS.map((rule) => `${rule.key}\u0000${rule.when ?? ""}`);
    expect(new Set(claims).size).toBe(claims.length);
  });

  it("compiles every default rule", () => {
    expect(DEFAULT_RESOLVED_KEYBINDINGS).toHaveLength(DEFAULT_KEYBINDINGS.length);
  });
});
