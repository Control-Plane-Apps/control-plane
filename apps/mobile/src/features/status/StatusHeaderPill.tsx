import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { NeedsYouPill, symbol } from "../tasks/taskUi";

// Fork-owned. The coordinator thread header's way into Status: "• 2 need you"
// when workstreams wait on the user, else a plain Status button. The iPad
// header names Status beside the count.

export function StatusHeaderPill(props: {
  readonly count: number;
  readonly showLabel: boolean;
  readonly onPress: () => void;
}) {
  const label = props.count > 0 ? `Status, ${props.count} need you` : "Status";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the coordinator's Status"
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 4,
      })}
    >
      {props.showLabel || props.count === 0 ? (
        <View className="flex-row items-center gap-1.5 pl-1">
          <SymbolView
            name={symbol("checklist", "check")}
            size={15}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Text className="text-[15px] font-t3-medium text-foreground">Status</Text>
        </View>
      ) : null}
      {props.count > 0 ? <NeedsYouPill count={props.count} /> : null}
    </Pressable>
  );
}
