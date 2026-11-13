import { cn } from "../../lib/utils";
import type { ThemePreferenceMode } from "../../themePalette";
import { STANDARD_THEME_CARDS, previewColorsOf } from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const MODES: ReadonlyArray<{ id: ThemePreferenceMode; label: string; ariaLabel: string }> = [
  { id: "system", label: "System", ariaLabel: "Follow the system appearance" },
  { id: "light", label: "Light", ariaLabel: "Use light mode" },
  { id: "dark", label: "Dark", ariaLabel: "Use dark mode" },
];

const PAPER_AND_CLAY = STANDARD_THEME_CARDS[0]!;

/** Light, dark, or follow the system. Paper and clay is the only palette. */
export function AppearanceModePicker({
  appearanceMode,
  setAppearanceMode,
}: {
  appearanceMode: ThemePreferenceMode;
  setAppearanceMode: (mode: ThemePreferenceMode) => boolean;
}) {
  const light = previewColorsOf(PAPER_AND_CLAY, "light");
  const dark = previewColorsOf(PAPER_AND_CLAY, "dark");
  return (
    <div aria-label="Appearance mode" className="grid w-full grid-cols-3 gap-3" role="group">
      {MODES.map((mode) => {
        const isActive = appearanceMode === mode.id;
        const panes =
          mode.id === "system"
            ? [
                { clip: "left" as const, colors: light! },
                { clip: "right" as const, colors: dark! },
              ]
            : [{ colors: (mode.id === "dark" ? dark : light)! }];
        return (
          <button
            aria-label={mode.ariaLabel}
            aria-pressed={isActive}
            className={cn(
              "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-transparent bg-accent/30"
                : "border-border/70 bg-card/60 hover:bg-accent/10",
            )}
            key={mode.id}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
            onClick={() => setAppearanceMode(mode.id)}
            type="button"
          >
            <ThemeWireframe className="h-[8.75rem]" panes={panes} />
            <span
              className={cn(
                "flex items-center justify-center text-xs font-medium",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {mode.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
