import { ClipboardListIcon, CircleAlertIcon, SunriseIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";

// Fork-owned. What an Assistant channel shows before it has any messages. On
// Today it keeps the brief's place: a greeting, the brief's status and the
// live counts the brief would lead with, so the page never opens on a blank
// chat.

export interface AssistantTodayEmptyProps {
  /** Today (the coordinator thread) or another channel. */
  readonly kind: "today" | "channel";
  readonly channelLabel: string;
  /** The brief schedule's time ("07:00") when it is on, else null. */
  readonly briefTime: string | null;
  readonly briefDays: "weekdays" | "every-day";
  readonly needsYouCount: number;
  readonly tasksTodayCount: number | null;
  readonly now: Date;
  readonly onOpenSettings: () => void;
  readonly onOpenTasks: () => void;
}

export function greetingFor(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "07:00" -> "7:00 AM" in the user's locale. */
export function formatBriefTime(time: string): string {
  const [hours, minutes] = time.split(":").map((part) => Number.parseInt(part, 10));
  const date = new Date(2000, 0, 1, hours ?? 7, minutes ?? 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function AssistantTodayEmpty(props: AssistantTodayEmptyProps) {
  if (props.kind === "channel") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-5 pt-10">
        <h2 className="text-base font-semibold text-foreground">{props.channelLabel}</h2>
        <p className="text-sm text-muted-foreground">
          Nothing here yet. Ask the Assistant something and the conversation stays in this channel.
        </p>
      </div>
    );
  }
  const lines: Array<{ key: string; icon: ReactNode; text: ReactNode }> = [];
  lines.push({
    key: "needs",
    icon: <CircleAlertIcon aria-hidden className="size-4" />,
    text:
      props.needsYouCount === 0
        ? "Nothing needs you across your Projects right now."
        : `${props.needsYouCount} ${props.needsYouCount === 1 ? "question needs" : "questions need"} you across your Projects.`,
  });
  if (props.tasksTodayCount !== null) {
    lines.push({
      key: "tasks",
      icon: <ClipboardListIcon aria-hidden className="size-4" />,
      text: (
        <>
          {props.tasksTodayCount === 0
            ? "No tasks today."
            : `${props.tasksTodayCount} ${props.tasksTodayCount === 1 ? "task" : "tasks"} today.`}{" "}
          <button
            type="button"
            className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline"
            onClick={props.onOpenTasks}
          >
            Open Tasks
          </button>
        </>
      ),
    });
  }
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pt-10"
      data-testid="assistant-today-empty"
    >
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold text-foreground">{greetingFor(props.now)}</h2>
        <span className="text-xs text-muted-foreground">
          {props.briefTime === null
            ? "No brief yet"
            : `Brief · ${formatBriefTime(props.briefTime)}${props.briefDays === "weekdays" ? " on weekdays" : ""}`}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.key} className="flex items-start gap-2.5 text-sm text-foreground">
            <span className="mt-0.5 shrink-0 text-muted-foreground">{line.icon}</span>
            <span>{line.text}</span>
          </li>
        ))}
        <li className="flex items-start gap-2.5 text-sm text-foreground">
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            <SunriseIcon aria-hidden className="size-4" />
          </span>
          <span>
            {props.briefTime === null
              ? "Turn on the morning brief and the Assistant writes one here each morning: what needs you, what moved, and today's tasks."
              : `Your next brief lands here at ${formatBriefTime(props.briefTime)}. Until then, ask anything across your Projects and tasks.`}
          </span>
        </li>
      </ul>
      {props.briefTime === null ? (
        <div>
          <Button size="sm" variant="outline" onClick={props.onOpenSettings}>
            Turn on morning brief
          </Button>
        </div>
      ) : null}
    </div>
  );
}
