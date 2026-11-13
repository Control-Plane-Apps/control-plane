import type { SFSymbol } from "expo-symbols";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

// Fork-owned. Small pieces shared by the Tasks and Status screens.

/** Drops AppTextInput's boxed field chrome for inline, in-row editing. */
export const BARE_INPUT_STYLE = {
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: "transparent",
  minHeight: 0,
  paddingHorizontal: 0,
  paddingVertical: 0,
} as const;

/** An SF Symbol with an Android fallback from the app's Material map. */
export function symbol(
  ios: SFSymbol,
  android: Extract<AppSymbolName, { ios: SFSymbol }>["android"] = "check",
): AppSymbolName {
  return { ios, android };
}

export interface TaskPalette {
  readonly accent: string;
  readonly accentForeground: string;
  readonly needsYou: string;
  readonly working: string;
  readonly done: string;
  readonly doneText: string;
  readonly queued: string;
  readonly overdue: string;
  readonly warningSurface: string;
  readonly warningBorder: string;
  readonly warningText: string;
  readonly chip: string;
  readonly dashed: string;
  readonly swipeSelect: string;
  readonly swipeMove: string;
  readonly swipeSchedule: string;
}

const LIGHT: TaskPalette = {
  accent: "#a8492a",
  accentForeground: "#ffffff",
  needsYou: "#d97706",
  working: "#2f6f95",
  done: "#4d7c0f",
  doneText: "#3f6212",
  queued: "#a8a29e",
  overdue: "#a8492a",
  warningSurface: "#fdf0dc",
  warningBorder: "#f3cf9a",
  warningText: "#9a4a0b",
  chip: "rgba(120, 100, 80, 0.12)",
  dashed: "rgba(60, 50, 40, 0.45)",
  swipeSelect: "#ece6dc",
  swipeMove: "#6d6258",
  swipeSchedule: "#2f7d9a",
};

const DARK: TaskPalette = {
  accent: "#c2603d",
  accentForeground: "#ffffff",
  needsYou: "#f59e0b",
  working: "#5aa3cc",
  done: "#84cc16",
  doneText: "#a3d977",
  queued: "#78716c",
  overdue: "#e08a62",
  warningSurface: "rgba(245, 158, 11, 0.16)",
  warningBorder: "rgba(245, 158, 11, 0.4)",
  warningText: "#f5b86b",
  chip: "rgba(255, 255, 255, 0.1)",
  dashed: "rgba(255, 255, 255, 0.45)",
  swipeSelect: "#3a3530",
  swipeMove: "#57504a",
  swipeSchedule: "#2b6f88",
};

export function useTaskPalette(): TaskPalette {
  const { themeAppearance } = useAppearancePreferences();
  return themeAppearance === "dark" ? DARK : LIGHT;
}

/** The square checkbox; dashed while the task is a coordinator's proposal. */
export function TaskCheckbox(props: {
  readonly checked: boolean;
  readonly proposed?: boolean;
  readonly selecting?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  const palette = useTaskPalette();
  const round = props.selecting === true;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="size-11 items-center justify-center"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: round ? 11 : 7,
          borderWidth: props.checked ? 0 : 1.5,
          borderStyle: props.proposed ? "dashed" : "solid",
          borderColor: props.proposed ? palette.dashed : "rgba(120, 110, 100, 0.7)",
          backgroundColor: props.checked ? palette.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {props.checked ? (
          <SymbolView
            name={symbol("checkmark")}
            size={12}
            tintColor={palette.accentForeground}
            type="monochrome"
            weight="bold"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/** A rounded chip: dashed when it offers to set something, filled when set. */
export function TaskChip(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly iconTint?: string;
  readonly active: boolean;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly leading?: ReactNode;
}) {
  const palette = useTaskPalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({
        opacity: props.disabled ? 0.4 : pressed ? 0.6 : 1,
        minHeight: 34,
        paddingHorizontal: 12,
        borderRadius: 17,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: props.active ? palette.chip : "transparent",
        borderWidth: props.active ? 0 : 1,
        borderStyle: "dashed",
        borderColor: palette.dashed,
      })}
    >
      {props.leading}
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={14}
          tintColorClassName={props.iconTint ? undefined : "accent-foreground-secondary"}
          tintColor={props.iconTint}
          type="monochrome"
        />
      ) : null}
      <Text className="text-[14px] text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function SectionLabel(props: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "warning";
  readonly trailing?: ReactNode;
}) {
  const palette = useTaskPalette();
  return (
    <View className="flex-row items-center gap-1.5 px-5 pt-5 pb-2">
      <Text
        className={cn(
          "text-[13px] font-t3-medium",
          props.tone !== "warning" && "text-foreground-muted",
        )}
        style={props.tone === "warning" ? { color: palette.warningText } : undefined}
      >
        {props.children}
      </Text>
      {props.trailing}
    </View>
  );
}

/** A grouped card, as in the design's rounded lists. */
export function TaskCard(props: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <View className="mx-4 overflow-hidden rounded-2xl bg-card" style={props.style}>
      {props.children}
    </View>
  );
}

export function RowSeparator(props: { readonly inset?: number }) {
  return <View className="h-px bg-border" style={{ marginLeft: props.inset ?? 52 }} />;
}

export interface UndoNotice {
  readonly id: number;
  readonly text: string;
  readonly onUndo: () => void;
}

const UNDO_VISIBLE_MS = 6000;

/** "Checked off X · Undo": a bottom banner that hides itself. */
export function useUndoNotice() {
  const [notice, setNotice] = useState<UndoNotice | null>(null);
  const counter = useRef(0);
  useEffect(() => {
    if (notice === null) return;
    const timeout = setTimeout(() => setNotice(null), UNDO_VISIBLE_MS);
    return () => clearTimeout(timeout);
  }, [notice]);
  const show = useCallback((text: string, onUndo: () => void) => {
    counter.current += 1;
    setNotice({ id: counter.current, text, onUndo });
  }, []);
  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, show, dismiss };
}

export function UndoBanner(props: {
  readonly notice: UndoNotice | null;
  readonly onDismiss: () => void;
  readonly bottomOffset?: number;
}) {
  const palette = useTaskPalette();
  const insets = useSafeAreaInsets();
  if (props.notice === null) return null;
  const notice = props.notice;
  return (
    <Animated.View
      key={notice.id}
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: (props.bottomOffset ?? 0) + Math.max(insets.bottom, 12) + 8,
      }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={{
          backgroundColor: palette.accent,
          borderRadius: 14,
          minHeight: 48,
          paddingLeft: 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <SymbolView
          name={symbol("checkmark.circle")}
          size={17}
          tintColor={palette.accentForeground}
          type="monochrome"
        />
        <Text
          className="flex-1 text-[15px]"
          style={{ color: palette.accentForeground }}
          numberOfLines={1}
        >
          {notice.text}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo"
          onPress={() => {
            notice.onUndo();
            props.onDismiss();
          }}
          className="h-12 justify-center px-4"
        >
          <Text className="text-[15px] font-t3-bold" style={{ color: palette.accentForeground }}>
            Undo
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

/** The amber "• 2 need you" pill: header, Project rows. */
export function NeedsYouPill(props: {
  readonly count: number;
  readonly compact?: boolean;
  /** Narrow rows (iPad sidebar) show the count alone. */
  readonly countOnly?: boolean;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
}) {
  const palette = useTaskPalette();
  const body = (
    <View
      accessibilityLabel={props.onPress === undefined ? `${props.count} need you` : undefined}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: props.compact ? 8 : 10,
        height: props.compact ? 24 : 30,
        borderRadius: 15,
        backgroundColor: palette.warningSurface,
        borderWidth: 1,
        borderColor: palette.warningBorder,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.needsYou }} />
      <Text
        className={props.compact ? "text-[13px] font-t3-medium" : "text-[14px] font-t3-bold"}
        style={{ color: palette.warningText }}
        numberOfLines={1}
      >
        {props.countOnly ? props.count : `${props.count} need you`}
      </Text>
    </View>
  );
  if (props.onPress === undefined) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? `Status, ${props.count} need you`}
      onPress={props.onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        minHeight: 44,
        justifyContent: "center",
      })}
    >
      {body}
    </Pressable>
  );
}
