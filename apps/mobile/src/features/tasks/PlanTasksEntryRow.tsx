import { useAppNavigation } from "../threads/sidebar-navigation-shell";
import { taskCounts } from "@t3tools/client-runtime/state/projects";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { symbol } from "./taskUi";
import { useMobileTasks, useTaskToday } from "./useMobileTasks";

// Fork-owned. Home's way into personal tasks: "Tasks · 4 today".

export function PlanTasksEntryRow(props: { readonly pane: "screen" | "sidebar" }) {
  const navigation = useAppNavigation();
  const { available, tasks } = useMobileTasks();
  const today = useTaskToday();
  if (!available) return null;
  const counts = taskCounts(tasks, today);
  const sidebar = props.pane === "sidebar";
  const detail = counts.today > 0 ? `${counts.today} today` : null;
  return (
    <View className={sidebar ? "px-2 pt-2" : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={detail === null ? "Tasks" : `Tasks, ${detail}`}
        accessibilityHint="Opens your tasks"
        onPress={() => navigation.navigate("PlanTasks", { view: "today" })}
        className={cn(
          "flex-row items-center gap-3",
          sidebar ? "min-h-11 rounded-xl px-2.5" : "min-h-[54px] py-2 pl-5 pr-5",
        )}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <View className="size-5 items-center justify-center">
          <SymbolView
            name={symbol("checklist", "check")}
            size={sidebar ? 17 : 19}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
        </View>
        <Text
          className={cn(
            "flex-1 text-foreground",
            sidebar ? "text-base font-t3-medium" : "text-[17px]",
          )}
        >
          Tasks
        </Text>
        {detail !== null ? (
          <Text
            className={cn(
              "tabular-nums text-foreground-muted",
              sidebar ? "text-sm" : "text-[17px]",
            )}
          >
            {detail}
          </Text>
        ) : null}
        {!sidebar ? (
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
            weight="semibold"
          />
        ) : null}
      </Pressable>
      {!sidebar ? (
        <View className="h-px bg-border" style={{ marginLeft: 52, marginRight: 20 }} />
      ) : null}
    </View>
  );
}
