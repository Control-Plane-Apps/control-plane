import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskTime,
  homeForMove,
  parseQuickAdd,
} from "@t3tools/client-runtime/state/projects";
import type { TaskHome, TaskLinks, TaskRecurrence, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  CalendarIcon,
  FolderIcon,
  MessageCircleIcon,
  RepeatIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useTaskToday, useTasks } from "../../state/tasks";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { TaskMoveMenu, TaskReminderMenu, TaskRepeatMenu } from "./TaskMenus";
import { useTaskActions } from "./useTaskActions";

const useQuickAddStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));

export function openTaskQuickAdd() {
  useQuickAddStore.getState().setOpen(true);
}

const chip = (active: boolean, dashed = false) =>
  cn(
    "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent",
    dashed && !active && "border border-dashed border-border",
  );

/**
 * Quick add from anywhere (the tasks.quickAdd shortcut, or + beside Tasks).
 * A trailing phrase such as "tomorrow 9am" fills the day and reminder;
 * opened from a thread, the task links to it and its Project.
 */
export function TaskQuickAddHost() {
  const open = useQuickAddStore((state) => state.open);
  const setOpen = useQuickAddStore((state) => state.setOpen);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { environmentId } = useTasks();

  useEffect(() => {
    if (environmentId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "tasks.quickAdd") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [environmentId, keybindings, setOpen]);

  if (environmentId === null) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? <QuickAddForm onDone={() => setOpen(false)} /> : null}
    </Dialog>
  );
}

function QuickAddForm(props: { readonly onDone: () => void }) {
  const today = useTaskToday();
  const navigate = useNavigate();
  const { environmentId } = useTasks();
  const actions = useTaskActions(environmentId);
  const projects = useProjects().filter((project) => project.assistant != null);
  const threads = useThreadShells();
  const routeParams = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.params ?? {},
  });
  const routeThread = useMemo(() => {
    const target = resolveThreadRouteTarget(routeParams as Record<string, string | undefined>);
    if (target?.kind !== "server") return null;
    return threads.find((thread) => thread.id === target.threadRef.threadId) ?? null;
  }, [routeParams, threads]);

  const [text, setText] = useState("");
  const [homeOverride, setHomeOverride] = useState<TaskHome | null>(null);
  const [recurrence, setRecurrence] = useState<TaskRecurrence | null>(null);
  const [projectId, setProjectId] = useState<string | null>(routeThread?.projectId ?? null);
  const [threadId, setThreadId] = useState<ThreadId | null>(routeThread?.id ?? null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const parsed = parseQuickAdd(text, today);
  const home: TaskHome = homeOverride ?? parsed.home ?? { kind: "date", date: today };
  const reminder = home.kind === "date" ? home.reminderTime : undefined;
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const linkedThread = threads.find((thread) => thread.id === threadId) ?? null;

  const submit = async (openAfter: boolean) => {
    const title = parsed.title.trim();
    if (title.length === 0 || busy) return;
    setBusy(true);
    const links: TaskLinks | undefined =
      projectId === null && threadId === null
        ? undefined
        : {
            ...(projectId !== null ? { projectId: projectId as never } : {}),
            ...(threadId !== null ? { threadId } : {}),
          };
    const created = await actions.create({
      title,
      home,
      ...(recurrence !== null && home.kind === "date" ? { recurrence } : {}),
      ...(links !== undefined ? { links } : {}),
    });
    setBusy(false);
    if (created === null) return;
    props.onDone();
    if (openAfter) {
      const view = home.kind === "period" ? home.horizon : home.kind === "date" ? "today" : "all";
      void navigate({ to: "/tasks/$view", params: { view } });
    }
  };

  return (
    <DialogPopup
      showCloseButton={false}
      className="top-[12vh] max-w-xl self-start p-0"
      viewportClassName="items-start"
      initialFocus={inputRef}
    >
      <DialogTitle className="sr-only">Add task</DialogTitle>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit(true);
          }
        }}
      >
        <div className="flex items-center gap-2.5 px-4 pt-3.5">
          <span
            aria-hidden
            className="inline-flex size-4 shrink-0 rounded-[4px] border border-muted-foreground/45"
          />
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              aria-label="Task title"
              placeholder="Task title"
              maxLength={240}
              className="w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setHomeOverride(null);
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 px-4 pt-2 pb-3 ps-10">
          <TaskMoveMenu
            home={home}
            today={today}
            className={chip(true)}
            onMove={(target) => setHomeOverride(homeForMove(target, home, today))}
            onPickDate={(date) => setHomeOverride(homeForMove({ kind: "date", date }, home, today))}
          >
            <CalendarIcon aria-hidden className="size-3.5" />
            {formatTaskHome(home, today)}
          </TaskMoveMenu>
          {home.kind === "date" ? (
            <TaskReminderMenu
              time={reminder}
              className={chip(reminder !== undefined)}
              formatTime={formatTaskTime}
              onChange={(time) => {
                if (home.kind !== "date") return;
                const { reminderTime: _drop, ...rest } = home;
                setHomeOverride(time === null ? rest : { ...rest, reminderTime: time });
              }}
            >
              <BellIcon aria-hidden className="size-3.5" />
              {reminder !== undefined ? formatTaskTime(reminder) : "Remind"}
            </TaskReminderMenu>
          ) : null}
          <TaskRepeatMenu
            recurrence={recurrence ?? undefined}
            disabled={home.kind !== "date"}
            className={chip(recurrence !== null, true)}
            onChange={setRecurrence}
          >
            <RepeatIcon aria-hidden className="size-3.5" />
            {recurrence !== null ? formatTaskRecurrence(recurrence) : "Repeat"}
          </TaskRepeatMenu>
          <Menu>
            <MenuTrigger className={chip(project !== null)} aria-label="Project">
              <FolderIcon aria-hidden className="size-3.5" />
              {project?.title ?? "Project"}
            </MenuTrigger>
            <MenuPopup align="start" className="w-52">
              {projects.map((candidate) => (
                <MenuItem
                  key={`${candidate.environmentId}:${candidate.id}`}
                  onClick={() => {
                    setProjectId(candidate.id);
                    if (linkedThread !== null && linkedThread.projectId !== candidate.id) {
                      setThreadId(null);
                    }
                  }}
                >
                  {candidate.title}
                </MenuItem>
              ))}
              {project !== null ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      setProjectId(null);
                      setThreadId(null);
                    }}
                  >
                    No project
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
          {linkedThread !== null ? (
            <span className={chip(true)}>
              <MessageCircleIcon aria-hidden className="size-3.5" />
              Link {linkedThread.title}
              <button
                type="button"
                aria-label={`Unlink ${linkedThread.title}`}
                className="-me-1 inline-flex size-4 cursor-pointer items-center justify-center rounded hover:bg-background"
                onClick={() => setThreadId(null)}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 border-border border-t px-4 py-2.5 text-muted-foreground text-xs">
          <span className="flex items-center gap-1">
            <Kbd>Tab</Kbd> fields
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> add and open
          </span>
          <button
            type="submit"
            disabled={busy || parsed.title.trim().length === 0}
            className="ms-auto inline-flex h-7 cursor-pointer items-center rounded-md bg-primary px-3 font-medium text-primary-foreground text-xs disabled:opacity-50"
          >
            Add task
          </button>
        </div>
      </form>
    </DialogPopup>
  );
}
