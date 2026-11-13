import { formatTaskTime } from "@t3tools/client-runtime/state/projects";
import { isProposedTask, localTaskDate, type Task } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { hasDesktopNotifications } from "../../threadNotifications";
import { useTasks } from "../../state/tasks";
import { toastManager } from "../ui/toast";

const CHECK_MS = 30_000;
const STORAGE_KEY = "cplane:task-reminders-fired:v1";

function nowHHMM(nowMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(nowMs);
}

function readFired(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** Reminders due now: open tasks on today with a reminder time that has arrived. */
export function dueTaskReminders(
  tasks: ReadonlyArray<Task>,
  today: string,
  time: string,
  fired: ReadonlySet<string>,
): Task[] {
  return tasks.filter(
    (task) =>
      task.status === "todo" &&
      !isProposedTask(task) &&
      task.home.kind === "date" &&
      task.home.date === today &&
      task.home.reminderTime !== undefined &&
      task.home.reminderTime <= time &&
      !fired.has(`${task.id}@${today}T${task.home.reminderTime}`),
  );
}

/**
 * Fires each task reminder once, at its local time on its day, as a toast
 * and, when the window is in the background, a desktop notification.
 */
export function TaskReminderCoordinator() {
  const { tasks } = useTasks();
  const navigate = useNavigate();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    // Reminders that passed before this window opened stay quiet.
    const startedAt = nowHHMM(Date.now());
    const check = () => {
      const nowMs = Date.now();
      const today = localTaskDate(nowMs);
      const time = nowHHMM(nowMs);
      const fired = readFired();
      const due = dueTaskReminders(tasksRef.current, today, time, fired).filter(
        (task) => task.home.kind === "date" && (task.home.reminderTime ?? "") >= startedAt,
      );
      if (due.length === 0) return;
      for (const task of due) {
        if (task.home.kind !== "date" || task.home.reminderTime === undefined) continue;
        fired.add(`${task.id}@${today}T${task.home.reminderTime}`);
        const description = `Reminder for ${formatTaskTime(task.home.reminderTime)}`;
        toastManager.add({ type: "info", title: task.title, description });
        if (
          hasDesktopNotifications(mode) &&
          !(document.visibilityState === "visible" && document.hasFocus()) &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          try {
            const notification = new Notification(task.title, {
              body: description,
              tag: `task:${task.id}`,
            });
            notification.addEventListener("click", () => {
              notification.close();
              window.focus();
              void navigate({ to: "/tasks/$view", params: { view: "today" } });
            });
          } catch {
            // Some browsers expose Notification but reject desktop presentation.
          }
        }
      }
      // Keep only today's marks so the list never grows.
      const kept = [...fired].filter((key) => key.includes(`@${today}T`));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    };
    check();
    const interval = window.setInterval(check, CHECK_MS);
    return () => window.clearInterval(interval);
  }, [mode, navigate]);
  return null;
}
