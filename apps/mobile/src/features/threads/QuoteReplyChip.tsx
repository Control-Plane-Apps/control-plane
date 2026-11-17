import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { clearQuoteReply, useQuoteReply } from "./quoteReplyStore";

// Fork-owned. "<reply> Assistant: first line  x" above the composer while a
// quote-reply is set. Neutral, unlike the Status "Re:" chip, which it sits under.

export function QuoteReplyChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  const quote = useQuoteReply(threadKey);
  if (quote === null) return null;
  const firstLine = quote.text.split("\n")[0]?.trim() ?? "";
  return (
    <View className="flex-row px-4 pb-2">
      <View
        testID="quote-reply-chip"
        accessible
        accessibilityLabel={`Replying to ${quote.displayLabel}${firstLine ? `: ${firstLine}` : ""}`}
        className="h-9 max-w-full flex-row items-center gap-1.5 rounded-full border border-border bg-card pl-3"
      >
        <SymbolView
          name="arrowshape.turn.up.left"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="shrink text-[14px] text-foreground-muted" numberOfLines={1}>
          <Text className="font-t3-medium text-foreground">{quote.displayLabel}</Text>
          {firstLine ? `: ${firstLine}` : ""}
        </Text>
        <Pressable
          testID="quote-reply-chip-clear"
          accessibilityRole="button"
          accessibilityLabel={`Stop replying to ${quote.displayLabel}`}
          onPress={() => clearQuoteReply(threadKey)}
          hitSlop={6}
          className="h-9 w-9 items-center justify-center"
        >
          <SymbolView
            name="xmark"
            size={11}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
    </View>
  );
}
