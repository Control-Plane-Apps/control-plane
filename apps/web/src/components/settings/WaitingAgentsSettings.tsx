import type { WaitingAgent } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";

export function WaitingAgentsSettings({
  agents,
  fresh,
  resumingId,
  onResume,
}: {
  readonly agents: readonly WaitingAgent[];
  readonly fresh: boolean;
  readonly resumingId: string | null;
  readonly onResume: ((agent: WaitingAgent, destinationId?: string) => void) | undefined;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  return (
    <section aria-label="Waiting agents" className="space-y-2 border-y px-3 py-3 sm:px-4">
      <h3 className="text-sm font-medium">Waiting agents</h3>
      <ul className="space-y-3">
        {agents.map((agent) => (
          <li key={agent.threadId} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-words text-sm">
                {agent.title} <span className="text-muted-foreground">on {agent.machineLabel}</span>
              </p>
              {agent.branch || agent.commit ? (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {agent.branch}
                  {agent.branch && agent.commit ? " · " : ""}
                  {agent.commit?.slice(0, 12)}
                </p>
              ) : null}
              <p className="break-words text-xs text-muted-foreground">{agent.detail}</p>
            </div>
            {onResume && agent.destinations?.length ? (
              <div className="basis-full space-y-1 text-xs">
                <p>
                  To move this agent, prepare a separate destination checkout with the same branch,
                  commit, staged changes and non-ignored untracked files. Moving stops and archives
                  the original agent.
                </p>
                <select
                  aria-label={`Destination for ${agent.title}`}
                  value={selected[agent.waitId] ?? ""}
                  onChange={(event) =>
                    setSelected({ ...selected, [agent.waitId]: event.target.value })
                  }
                >
                  <option value="">Choose destination</option>
                  {agent.destinations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    !fresh ||
                    resumingId !== null ||
                    !agent.destinations.some((item) => item.id === selected[agent.waitId])
                  }
                  onClick={() => onResume(agent, selected[agent.waitId])}
                >
                  Verify and move
                </Button>
              </div>
            ) : null}
            {agent.canResume && onResume ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!fresh || resumingId !== null}
                aria-label={`Resume ${agent.title} on ${agent.machineLabel}`}
                onClick={() => onResume(agent)}
              >
                {resumingId === agent.threadId ? "Resuming…" : "Resume"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
