import type { AssistantAskCard, AssistantPing } from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ArrowRightIcon, BellIcon, CornerDownLeftIcon } from "lucide-react";
import { createContext, use, useState } from "react";

import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";

// Fork-owned. The Assistant's own timeline rows: one card per "ask every
// coordinator" with the answers folded in, and one per ping. The timeline
// reaches them through context so its row components stay unchanged.

export interface AssistantTimelineCardsValue {
  readonly asksByActivityId: ReadonlyMap<string, AssistantAskCard>;
  readonly pingsByActivityId: ReadonlyMap<string, AssistantPing>;
  readonly projectsById: ReadonlyMap<string, EnvironmentProject>;
  readonly onOpenCoordinator: (projectId: string) => void;
  readonly onPingReply: (reply: string) => void;
}

export const AssistantTimelineCardsContext = createContext<AssistantTimelineCardsValue | null>(
  null,
);

export function AssistantTimelineCard({ workEntry }: { workEntry: WorkLogEntry }) {
  const value = use(AssistantTimelineCardsContext);
  if (value === null) return null;
  if (workEntry.assistantCard === "ask") {
    const card = value.asksByActivityId.get(workEntry.id);
    return card ? <AskCard card={card} value={value} /> : null;
  }
  const ping = value.pingsByActivityId.get(workEntry.id);
  return ping ? <PingCard ping={ping} onReply={value.onPingReply} /> : null;
}

function AskCard({ card, value }: { card: AssistantAskCard; value: AssistantTimelineCardsValue }) {
  const count = card.targets.length;
  return (
    <section
      aria-label="Asked across your work"
      className="my-1 overflow-hidden rounded-xl border border-border bg-card"
      data-testid="assistant-ask-card"
    >
      <div className="flex items-center gap-1.5 px-3.5 py-2 text-xs text-muted-foreground">
        <ArrowRightIcon className="size-3.5 shrink-0" aria-hidden />
        Asked {count} {count === 1 ? "coordinator" : "coordinators"}
        <span className="flex-1" />
        <span className="tabular-nums">{card.answeredCount} answered</span>
      </div>
      <ul>
        {card.targets.map((target) => {
          const project = value.projectsById.get(target.projectId);
          return (
            <li key={target.projectId} className="border-t border-border px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-[13px]">
                {project ? (
                  <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                ) : null}
                <span className="shrink-0 font-medium text-foreground">{target.title}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {card.question}
                </span>
                {target.answer === null ? (
                  <span className="shrink-0 text-xs text-info-foreground">Waiting</span>
                ) : null}
                <button
                  type="button"
                  className="h-6 shrink-0 cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => value.onOpenCoordinator(target.projectId)}
                >
                  Open
                </button>
              </div>
              {target.answer !== null ? (
                <div className="mt-2 flex gap-2 pl-[22px]">
                  <CornerDownLeftIcon
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <p className="text-[13px] leading-normal whitespace-pre-wrap text-muted-foreground">
                    {target.answer.text}
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PingCard({ ping, onReply }: { ping: AssistantPing; onReply: (reply: string) => void }) {
  const [done, setDone] = useState<string | null>(null);
  return (
    <section
      aria-label="Assistant ping"
      className="my-1 flex gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3"
      data-testid="assistant-ping-card"
    >
      <BellIcon className="mt-0.5 size-4 shrink-0 text-attention-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{ping.title}</p>
        {ping.body ? <p className="mt-0.5 text-sm text-muted-foreground">{ping.body}</p> : null}
        {ping.actions.length > 0 ? (
          <div className={cn("mt-2 flex items-center gap-1.5", done !== null && "opacity-70")}>
            {ping.actions.map((action) => (
              <Button
                key={action.label}
                size="xs"
                disabled={done !== null}
                onClick={() => {
                  setDone(action.label);
                  onReply(action.reply);
                }}
              >
                {done === action.label ? "Sent" : action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
