import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { taskLocalDateOf } from "@t3tools/contracts";

// Fork-owned. "Pick a date" for platforms without the SwiftUI calendar: the
// system date dialog.

export interface TaskDatePickerProps {
  /** `YYYY-MM-DD`. */
  readonly value: string;
  readonly onChange: (date: string) => void;
  readonly onDismiss?: () => void;
}

export function dateFromTaskDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

export function taskDateFromDate(date: Date): string {
  return taskLocalDateOf(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function TaskDatePicker(props: TaskDatePickerProps) {
  return (
    <DateTimePicker
      mode="date"
      value={dateFromTaskDate(props.value)}
      onDismiss={() => props.onDismiss?.()}
      onValueChange={(_, date) => props.onChange(taskDateFromDate(date))}
    />
  );
}
