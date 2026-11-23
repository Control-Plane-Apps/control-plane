import { STATUS_RECOMMENDATION_BODY_PREFIX, type AssistantNeedsYouEntry } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { recommendationButtonLabel } from "../status/projectStatus.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useAssistantHomeEnvironment } from "./useAssistant";

/** Replies stay on the Assistant connection; the browser need not know the other machine. */
export function AssistantRemoteNeedsYouRow({
  item,
  first,
}: {
  item: AssistantNeedsYouEntry;
  first: boolean;
}) {
  const home = useAssistantHomeEnvironment();
  const reply = useAtomCommand(serverEnvironment.assistantNeedsYouReply, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status } = item;
  const disabled = item.stale || sending || sent || home === null;

  const send = async (body: string) => {
    if (disabled || body.trim().length === 0 || home === null) return;
    setSending(true);
    setError(null);
    const result = await reply({
      environmentId: home.environmentId,
      input: {
        environmentId: item.environmentId,
        projectId: item.projectId,
        coordinatorThreadId: item.coordinatorThreadId,
        statusId: status.id,
        openedAt: status.decision.openedAt,
        text: body,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setSent(true);
      setQueued(result.value.queued);
      setEditing(false);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <li
      className={cn("px-3.5 py-3", !first && "border-t border-border")}
      data-testid="assistant-needs-you-row"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">{item.projectTitle}</span>
        <span aria-hidden>·</span>
        <span className="truncate font-medium text-foreground">{status.title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {item.machineLabel}
        {item.stale ? " · Last known question, machine unavailable" : ""}
      </p>
      <p className="mt-1.5 mb-2 text-sm leading-snug text-foreground">{status.decision.question}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            void send(`${STATUS_RECOMMENDATION_BODY_PREFIX} ${status.decision.recommendation}`)
          }
        >
          {sent ? <CheckIcon aria-hidden /> : null}
          {sending
            ? "Sending…"
            : sent
              ? queued
                ? "Answer queued"
                : "You answered"
              : recommendationButtonLabel(status.decision)}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setEditing(!editing)}
        >
          Reply
        </Button>
      </div>
      {editing ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(text);
          }}
        >
          <Textarea
            aria-label={`Reply to ${status.title}`}
            value={text}
            maxLength={20_000}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={disabled || text.trim().length === 0}>
              Send reply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={sending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
