import type { AssistantPing } from "@t3tools/client-runtime/state/assistant-home";
import { BellIcon } from "lucide-react";

import { formatStatusAge } from "../status/projectStatus.logic";
import { useMinuteNow } from "../status/ProjectStatusPanel";
import { Button } from "../ui/button";

// Fork-owned. The Assistant's Inbox: every ping it raised, newest first.

export function AssistantInbox(props: {
  readonly pings: ReadonlyArray<AssistantPing>;
  readonly onReply: (reply: string) => void;
}) {
  const now = useMinuteNow();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-7 pb-6" data-testid="assistant-inbox">
      <div className="mx-auto flex max-w-[680px] flex-col gap-3">
        {props.pings.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-2 text-center">
            <BellIcon className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium text-foreground">No pings yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              When something across your Projects is time-sensitive, the Assistant pings you here
              and as a notification.
            </p>
          </div>
        ) : (
          props.pings.map((ping) => (
            <article
              key={ping.activityId}
              className="flex gap-2.5 rounded-xl border border-border bg-card px-4 py-3"
            >
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{ping.title}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatStatusAge(ping.createdAt, now)}
                  </span>
                </div>
                {ping.body ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">{ping.body}</p>
                ) : null}
                {ping.actions.length > 0 ? (
                  <div className="mt-2 flex gap-1.5">
                    {ping.actions.map((action) => (
                      <Button
                        key={action.label}
                        size="xs"
                        onClick={() => props.onReply(action.reply)}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
