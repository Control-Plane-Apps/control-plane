import { ActivityIndicator, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { RowPressable } from "../../components/RowPressable";
import { rollupDotColor, ThreadStatusDot } from "../threads/thread-status-dot";
import { AssistantMark } from "./AssistantMark";
import type { AssistantEntry } from "./useAssistantEntry";

// Fork-owned. The Assistant's row at the top of the iPhone Home list, above
// every Project: its mark, its name and how many questions wait on the user.

/** The orange of a waiting question, shared with the thread rows' approval dot. */
export const NEEDS_YOU_DOT_COLOR = rollupDotColor("approval");
/** The blue of moving work, shared with the thread rows' working dot. */
export const WORKING_DOT_COLOR = rollupDotColor("working");

export function AssistantHomeRow(props: { readonly entry: AssistantEntry }) {
  const { entry } = props;
  const count = entry.needsYouCount;
  return (
    <View>
      <RowPressable
        accessibilityHint="Opens the Assistant"
        accessibilityLabel={count > 0 ? `Assistant, ${count} need you` : "Assistant"}
        accessibilityRole="button"
        accessibilityState={{ busy: entry.opening }}
        onPress={entry.open}
      >
        <View className="min-h-[54px] flex-row items-center gap-3 py-2 pr-5 pl-5">
          <AssistantMark size={20} />
          <Text className="flex-1 text-[17px] text-foreground" numberOfLines={1}>
            Assistant
          </Text>
          {entry.opening ? <ActivityIndicator colorClassName="accent-icon-muted" /> : null}
          {count > 0 ? (
            <View className="flex-row items-center gap-1.5">
              <ThreadStatusDot color={NEEDS_YOU_DOT_COLOR} grouped />
              <Text className="text-[17px] tabular-nums text-foreground-muted">{count}</Text>
            </View>
          ) : null}
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
            weight="semibold"
          />
        </View>
      </RowPressable>
      <View className="ml-[52px] mr-5 h-px bg-border" />
    </View>
  );
}
