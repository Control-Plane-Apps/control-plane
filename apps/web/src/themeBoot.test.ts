import { describe, expect, it, vi } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  invalidateCustomThemes,
  isKnownThemePreference,
  resolveThemeAppearance,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  toCanonicalThemeColor,
} from "./themePalette";

const THEME_STORAGE_KEY = "t3code:theme";

const bootScript = (() => {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the inline boot script in index.html");
  return match[1];
})();

type BootResult = {
  isDark: boolean;
  themeId: string | undefined;
  themeSelected: string | undefined;
  backgroundColor: string;
  bootVariables: Record<string, string>;
  metaContent: string | null;
  storage: Record<string, string>;
};

function runBootScript(options: {
  storage?: Record<string, string>;
  storageThrows?: boolean;
  prefersDark: boolean;
}): BootResult {
  const classes = new Set<string>();
  const bootVariables: Record<string, string> = {};
  const meta = {
    content: null as string | null,
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };
  const documentElement = {
    dataset: {} as Record<string, string | undefined>,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    style: {
      backgroundColor: "",
      setProperty: (name: string, value: string) => {
        bootVariables[name] = value;
      },
    },
  };
  const fakeDocument = {
    documentElement,
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? [meta] : []),
  };
  const store: Record<string, string> = { ...options.storage };
  const fakeWindow = {
    localStorage: {
      getItem: (key: string): string | null => {
        if (options.storageThrows) throw new Error("storage blocked");
        return store[key] ?? null;
      },
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
    matchMedia: () => ({ matches: options.prefersDark }),
  };

  const fakeCss = {
    supports: (property: string, value: string) =>
      property === "color" && toCanonicalThemeColor(value) !== null,
  };

  new Function("window", "document", "CSS", bootScript)(fakeWindow, fakeDocument, fakeCss);

  return {
    isDark: classes.has("dark"),
    themeId: documentElement.dataset.themeId,
    themeSelected: documentElement.dataset.themeSelected,
    backgroundColor: documentElement.style.backgroundColor,
    bootVariables,
    metaContent: meta.content,
    storage: store,
  };
}

/** Mirrors getStored + readAppearanceModePreference + resolveThemeAppearance from the runtime. */
function runtimeResolvedAppearance(
  storage: Record<string, string>,
  prefersDark: boolean,
): "light" | "dark" {
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    matchMedia: () => ({ matches: prefersDark }),
  });
  invalidateCustomThemes();
  try {
    const raw = storage[THEME_STORAGE_KEY] ?? null;
    const theme = raw !== null && isKnownThemePreference(raw) ? raw : "system";
    const followRaw = storage[THEME_FOLLOW_SYSTEM_STORAGE_KEY] ?? null;
    const appearanceRaw = storage[THEME_APPEARANCE_MODE_STORAGE_KEY] ?? null;
    const appearanceMode =
      appearanceRaw === "light" || appearanceRaw === "dark" || appearanceRaw === "system"
        ? appearanceRaw
        : followRaw === "true"
          ? "system"
          : followRaw === "false"
            ? null
            : theme === "system"
              ? "system"
              : null;
    const followSystem = appearanceMode === "system";
    return resolveThemeAppearance(theme, prefersDark, followSystem, appearanceMode ?? undefined);
  } finally {
    vi.unstubAllGlobals();
    invalidateCustomThemes();
  }
}

const AURORA_DUAL = {
  id: "aurora",
  label: "Aurora",
  appearance: "light",
  colors: { canvas: "#f8fbff", text: "#10243d", accent: "#5b6cff" },
  variants: { dark: { canvas: "#101827", text: "#eef5ff", accent: "#7c93ff" } },
};
const CHARCOAL_DARK_ONLY = {
  id: "charcoal",
  label: "Charcoal",
  appearance: "dark",
  colors: { canvas: "#1c1210", text: "#ffe8d9", accent: "#ff7a45" },
};

describe("index.html boot script", () => {
  const parityCases: ReadonlyArray<{
    name: string;
    storage: Record<string, string>;
    prefersDark: boolean;
  }> = [
    { name: "no stored preference on a dark OS", storage: {}, prefersDark: true },
    {
      name: "T3 Chat follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "t3-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "an explicit global dark mode applies to T3 Chat",
      storage: {
        [THEME_STORAGE_KEY]: "t3-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false",
      },
      prefersDark: false,
    },
    {
      name: "Grove follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Ocean follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "ocean", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Ember follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "ember", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Iris follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "iris", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "a legacy t3-grove preference resolves through the alias",
      storage: { [THEME_STORAGE_KEY]: "t3-grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "legacy t3-chat-dark resolves to dark T3 Chat",
      storage: { [THEME_STORAGE_KEY]: "t3-chat-dark" },
      prefersDark: true,
    },
    {
      name: "a dual-mode custom theme follows the OS",
      storage: {
        [THEME_STORAGE_KEY]: "aurora",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    },
    {
      name: "a legacy mode-suffixed preference is treated as unknown",
      storage: {
        [THEME_STORAGE_KEY]: "aurora:dark",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    },
    {
      name: "a removed custom theme falls back to system",
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    },
    {
      name: "a corrupted follow-system value falls back to inference",
      storage: { [THEME_STORAGE_KEY]: "system", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "1" },
      prefersDark: true,
    },
    {
      name: "follow-system off keeps an explicit light preference on a dark OS",
      storage: { [THEME_STORAGE_KEY]: "light", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: true,
    },
    {
      name: "a bare dark preference stays dark on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark" },
      prefersDark: false,
    },
    {
      name: "follow-system off keeps a bare dark preference on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: false,
    },
  ];

  it.each(parityCases)("matches the runtime appearance: $name", ({ storage, prefersDark }) => {
    const boot = runBootScript({ storage, prefersDark });
    expect(boot.isDark).toBe(runtimeResolvedAppearance(storage, prefersDark) === "dark");
  });

  it("leaves unknown preferences unthemed so the runtime default applies", () => {
    const boot = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.isDark).toBe(true);
  });

  it("migrates saved themes to Paper and clay, keeping the appearance mode", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "ocean",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark",
        "t3code:theme-halves:v1": JSON.stringify({ light: "grove" }),
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([CHARCOAL_DARK_ONLY]),
      },
      prefersDark: false,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.isDark).toBe(true);
    expect(boot.storage[THEME_STORAGE_KEY]).toBe("dark");
    expect(boot.storage["t3code:theme-halves:v1"]).toBeUndefined();
    expect(boot.storage[CUSTOM_THEMES_STORAGE_KEY]).toBeUndefined();
  });

  it("migrates a dark-only custom theme without a saved mode to dark", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "charcoal",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([CHARCOAL_DARK_ONLY]),
      },
      prefersDark: false,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.isDark).toBe(true);
    expect(boot.storage[THEME_STORAGE_KEY]).toBe("dark");
  });

  it("follows the OS appearance when storage is unavailable", () => {
    const light = runBootScript({ storageThrows: true, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBeUndefined();

    const dark = runBootScript({ storageThrows: true, prefersDark: true });
    expect(dark.isDark).toBe(true);
  });
});
