import { XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Button, buttonVariants } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { cn } from "../../lib/utils";
import { TaskMoveMenu } from "./TaskMenus";

const ghostAction = cn(buttonVariants({ variant: "ghost", size: "compact" }), "text-[13px]");

/**
 * Floating action bar for a multi-task selection. It is an overlay pinned to the bottom of the
 * Tasks pane (the parent supplies `relative`), so it never reflows the list.
 */
export function TaskBulkBar(props: {
  readonly count: number;
  readonly moveProps: Omit<ComponentProps<typeof TaskMoveMenu>, "children" | "className">;
  readonly canHandToAssistant: boolean;
  readonly onHandToAssistant: () => void;
  readonly onDelete: () => void;
  readonly onClear: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Selected task actions"
        className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border bg-popover p-1 text-[13px] text-foreground shadow-lg/10"
      >
        <span className="px-2 text-muted-foreground tabular-nums">{props.count} selected</span>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <TaskMoveMenu {...props.moveProps} className={ghostAction}>
          Move
        </TaskMoveMenu>
        <Button
          variant="ghost"
          size="compact"
          className="text-[13px]"
          disabled={!props.canHandToAssistant}
          onClick={props.onHandToAssistant}
        >
          Hand to Assistant
        </Button>
        <Button
          variant="ghost"
          size="compact"
          className="text-[13px] text-destructive hover:text-destructive"
          onClick={props.onDelete}
        >
          Delete {props.count}
        </Button>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Clear selection"
          onClick={props.onClear}
        >
          <XIcon aria-hidden />
        </Button>
        <Kbd aria-hidden className="me-1">
          Esc
        </Kbd>
      </div>
    </div>
  );
}
