import type { WaitingAgent } from "@t3tools/contracts";
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
  readonly onResume: ((agent: WaitingAgent) => void) | undefined;
}) {
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
                  {agent.commit && <span title={agent.commit}>{agent.commit.slice(0, 12)}</span>}
                </p>
              ) : null}
              <p className="break-words text-xs text-muted-foreground">{agent.detail}</p>
            </div>
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
