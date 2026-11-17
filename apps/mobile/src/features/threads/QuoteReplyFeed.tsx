import type { ParsedQuoteReply } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

// Fork-owned. Quote-reply in the thread feed: swipe a message right (or pick
// Reply from its long-press menu) to quote it in the composer; a sent reply's
// bubble shows the quote, and tapping it jumps back to the original.

/** Past this, a released swipe starts a reply. */
const REPLY_SWIPE_THRESHOLD = 56;
/** The row follows the finger up to here, with resistance past the threshold. */
const REPLY_SWIPE_MAX = 84;
const HIGHLIGHT_HOLD_MS = 900;

export interface QuoteReplyFeedActions {
  /** Starts a whole-message reply to a loaded message. */
  readonly startReply: (messageId: string) => void;
  /** The author name a sent quote shows, and whether its original is loaded. */
  readonly resolveQuote: (quote: ParsedQuoteReply) => {
    readonly displayLabel: string;
    readonly canJump: boolean;
  };
  readonly jumpToMessage: (messageId: string) => void;
}

export const QuoteReplyFeedContext = createContext<QuoteReplyFeedActions | null>(null);

/** The message briefly flashed after a jump; `token` restarts the flash on a repeat tap. */
export const QuoteReplyHighlightContext = createContext<{
  readonly messageId: string;
  readonly token: number;
} | null>(null);

/** Long-press actions for a message: Reply, Copy. A native sheet, not a context menu, so
 *  it never competes with the selectable text's own long-press selection. */
export function showMessageActions(input: {
  readonly onReply: (() => void) | null;
  readonly onCopy: (() => void) | null;
}): void {
  const actions = [
    ...(input.onReply ? [{ title: "Reply", run: input.onReply }] : []),
    ...(input.onCopy ? [{ title: "Copy", run: input.onCopy }] : []),
  ];
  if (actions.length === 0) return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.title), "Cancel"],
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.run(),
    );
    return;
  }
  Alert.alert("Message", undefined, [
    ...actions.map((action) => ({ text: action.title, onPress: action.run })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

function replyHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/**
 * A feed message that can be swiped right to reply, and flashes when a quote
 * jumps to it. Vertical movement fails the pan, so the list scrolls as before.
 */
export function QuoteReplySwipeRow(props: {
  readonly messageId: string;
  readonly iconColor: string | import("react-native").ColorValue;
  readonly children: ReactNode;
}) {
  const actions = useContext(QuoteReplyFeedContext);
  const highlight = useContext(QuoteReplyHighlightContext);
  const translateX = useSharedValue(0);
  const armed = useSharedValue(false);
  const flash = useSharedValue(0);
  const { messageId } = props;
  const startReply = actions?.startReply;

  const highlightToken = highlight?.messageId === messageId ? highlight.token : null;
  useEffect(() => {
    if (highlightToken === null) return;
    flash.set(
      withSequence(
        withTiming(1, { duration: 160 }),
        withDelay(HIGHLIGHT_HOLD_MS, withTiming(0, { duration: 320 })),
      ),
    );
  }, [flash, highlightToken]);

  const gesture = useMemo(() => {
    const onReply = () => startReply?.(messageId);
    return (
      Gesture.Pan()
        .enabled(startReply !== undefined)
        // Rightward only; leave the screen edge to the back gesture.
        .activeOffsetX(16)
        .failOffsetX(-12)
        .failOffsetY([-10, 10])
        .hitSlop({ left: -12 })
        .onUpdate((event) => {
          const x = Math.max(0, event.translationX);
          translateX.set(
            x <= REPLY_SWIPE_THRESHOLD
              ? x
              : Math.min(
                  REPLY_SWIPE_MAX,
                  REPLY_SWIPE_THRESHOLD + (x - REPLY_SWIPE_THRESHOLD) * 0.35,
                ),
          );
          const past = x >= REPLY_SWIPE_THRESHOLD;
          if (past !== armed.get()) {
            armed.set(past);
            if (past) runOnJS(replyHaptic)();
          }
        })
        .onEnd(() => {
          if (armed.get()) runOnJS(onReply)();
        })
        .onFinalize(() => {
          armed.set(false);
          translateX.set(withSpring(0, { damping: 22, stiffness: 260, mass: 0.6 }));
        })
    );
  }, [armed, messageId, startReply, translateX]);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
  }));
  const iconStyle = useAnimatedStyle(() => {
    const progress = Math.min(1, translateX.get() / REPLY_SWIPE_THRESHOLD);
    return {
      opacity: progress,
      transform: [{ scale: interpolate(progress, [0, 1], [0.6, 1]) }],
    };
  });
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.get() * 0.14 }));

  return (
    <View testID={`thread-message-${messageId}`}>
      <Animated.View
        pointerEvents="none"
        className="rounded-2xl bg-primary"
        style={[StyleSheet.absoluteFill, styles.flash, flashStyle]}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.replyIcon, iconStyle]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View className="size-8 items-center justify-center rounded-full bg-secondary">
          <SymbolView
            name="arrowshape.turn.up.left"
            size={14}
            tintColor={props.iconColor}
            type="monochrome"
          />
        </View>
      </Animated.View>
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={rowStyle}
          accessibilityActions={startReply ? [{ name: "reply", label: "Reply" }] : undefined}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "reply") startReply?.(messageId);
          }}
        >
          {props.children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** The quote at the top of a sent reply's bubble: author, two lines, tap to jump. */
export function QuoteReplyBlock(props: { readonly quote: ParsedQuoteReply }) {
  const actions = useContext(QuoteReplyFeedContext);
  const resolved = actions?.resolveQuote(props.quote) ?? {
    displayLabel: props.quote.label,
    canJump: false,
  };
  const { messageId } = props.quote;
  const text = props.quote.text.trim();
  return (
    <Pressable
      testID="quote-reply-block"
      accessibilityRole={resolved.canJump ? "button" : "text"}
      accessibilityLabel={`Replying to ${resolved.displayLabel}${text ? `: ${text}` : ""}`}
      accessibilityHint={resolved.canJump ? "Shows the original message" : undefined}
      disabled={!resolved.canJump}
      onPress={() => actions?.jumpToMessage(messageId)}
      className="mb-1 flex-row gap-2 pt-0.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="w-[3px] rounded-full bg-user-bubble-foreground-muted opacity-60" />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-1">
          <SymbolView
            name="arrowshape.turn.up.left"
            size={11}
            tintColorClassName="accent-user-bubble-foreground-muted"
            type="monochrome"
          />
          <Text
            className="shrink font-t3-medium text-[12px] text-user-bubble-foreground-muted"
            numberOfLines={1}
          >
            {resolved.displayLabel}
          </Text>
        </View>
        {text ? (
          <Text
            className="text-[13px] leading-[18px] text-user-bubble-foreground-muted"
            numberOfLines={2}
          >
            {text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flash: { marginHorizontal: -6, opacity: 0 },
  replyIcon: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
});
