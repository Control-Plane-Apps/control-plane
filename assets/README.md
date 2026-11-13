# Brand icons

The vector tiles `app-icon-light.svg`, `app-icon-dark.svg`, and `app-icon-tinted.svg` are the sources of truth. Light uses the design's clay (#b04f26) and white mark, dark uses brown (#1f1a16) and cream (#faf8f5), and tinted is grayscale for iOS system tinting. The four paths and the 38/64 mark framing come from the Control Plane mark design sheet.

Run `vp run icons:export` to render all three channel families, iOS appearance variants, desktop icons, web manifest icons, and both marketing sites' favicons. Run `vp run icons:check` to check their contents. The channel filenames are retained for packaging compatibility; all channels use the same approved tile. iOS selects light, dark, or tinted through `ios.icon` in the Expo config.

The Electron packaging path generates a single ICNS from the macOS PNG. It does not compile Icon Composer appearance assets, so macOS uses clay in both appearances. No ICNS is tracked; development and release packaging regenerate it from these PNGs.

The macOS PNGs keep their classic pre-Tahoe tile: the rounded 824×824 body inset 100px with its shadow comes from the tracked file, and the exporter only repaints the body with the master. To start a new variant, copy an existing macOS PNG and export.

Do not edit the generated PNG or ICO files directly. Change a vector tile and export.

## Android launcher and mobile splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the square master tiles cannot be used directly. The
Android artwork is instead rendered from the variant mark SVGs by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground-*.png`: the transparent jet, sized to stay inside
  the safe zone over the clay adaptive background color.
- `apps/mobile/assets/android-splash-icon-*.png`: the same foreground at the full splash canvas,
  so the splash mask frames the jet like the launcher does.
- `apps/mobile/assets/ios-splash-icon-*.png`: the transparent jet for the iOS splash screen,
  which draws its image unmasked over the light or dark splash background. Never point the iOS
  splash at the square app icon tiles: they show as a white box in dark mode.
- `apps/mobile/assets/android-icon-mark.png` and `android-notification-icon.png`: flat white
  silhouettes for Android's monochrome themed icon and the status bar.

Rerun the export after changing a mark SVG.
