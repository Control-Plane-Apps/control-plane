import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle } from "@expo/ui/swift-ui/modifiers";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  dateFromTaskDate,
  taskDateFromDate,
  type TaskDatePickerProps,
} from "./TaskDatePicker.shared";

// Fork-owned. The Move sheet's "Pick a date": the system's inline calendar.

export function TaskDatePicker(props: TaskDatePickerProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  return (
    <Host matchContents colorScheme={themeAppearance} seedColor={colors["--color-primary"]}>
      <DatePicker
        title="Pick a date"
        selection={dateFromTaskDate(props.value)}
        displayedComponents={["date"]}
        onDateChange={(date) => props.onChange(taskDateFromDate(date))}
        modifiers={[datePickerStyle("graphical")]}
      />
    </Host>
  );
}
