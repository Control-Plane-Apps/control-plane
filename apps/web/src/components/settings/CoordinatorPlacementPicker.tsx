import {
  LOCAL_AGENT_MACHINE,
  type CoordinatorMoveInput,
  type CoordinatorMoveStatus,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { agentMachinesErrorMessage } from "./AgentMachinesSettings.logic";

export type CoordinatorMoveRequest = Omit<CoordinatorMoveInput, "action" | "projectId">;
type Machine = { readonly id: string; readonly label: string };

export function CoordinatorPlacementPicker({
  localLabel,
  projectKey,
  machines,
  run,
}: {
  projectKey: string;
  localLabel: string;
  machines: readonly Machine[];
  run: (request: CoordinatorMoveRequest) => Promise<CoordinatorMoveStatus>;
}) {
  const receiptKey = "coordinator-move:" + projectKey;
  const [status, setStatus] = useState<CoordinatorMoveStatus | null>(null);
  const [review, setReview] = useState<{
    destination: Machine;
    check: CoordinatorMoveStatus;
  } | null>(null);
  const [rollback, setRollback] = useState(false);
  const [pending, setPending] = useState<CoordinatorMoveRequest | null>({ operation: "status" });
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const execute = useCallback(
    async (request: CoordinatorMoveRequest, destination?: Machine) => {
      const sequence = ++requestId.current;
      setPending(request);
      setError("");
      setReview(null);
      setRollback(false);
      try {
        // Keep the original request identity across a reload or a lost acknowledgement.
        if (request.operation === "move" && request.destinationId && request.approvalDigest) {
          const key = receiptKey + ":" + request.destinationId;
          const saved = localStorage.getItem(key);
          const prefix = request.approvalDigest + "\n";
          const moveId = saved?.startsWith(prefix) ? saved.slice(prefix.length) : randomUUID();
          localStorage.setItem(key, prefix + moveId);
          request = { ...request, moveId };
        }
        const response = await run(request);
        if (sequence !== requestId.current) return;
        if (response.phase === "rolled-back" && response.destinationId) {
          const key = receiptKey + ":" + response.destinationId;
          if (response.moveId && localStorage.getItem(key)?.endsWith("\n" + response.moveId)) {
            localStorage.removeItem(key);
          }
        }
        if (destination) setReview({ destination, check: response });
        else setStatus(response);
      } catch (cause) {
        if (sequence !== requestId.current) return;
        setError(agentMachinesErrorMessage(cause));
        setStatus(null);
      } finally {
        if (sequence === requestId.current) setPending(null);
      }
    },
    [run, receiptKey],
  );

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Read the server's durable receipt whenever this Project is opened.
    void execute({ operation: "status" });
    return () => {
      requestId.current++;
    };
  }, [execute]);

  const approvalDigest = review?.check.ready ? review.check.approvalDigest : undefined;
  const busy = pending !== null;
  const canPick =
    !status?.incoming && (status?.phase === "idle" || status?.phase === "rolled-back");
  const paused = !!status && !["idle", "active", "rolled-back"].includes(status.phase);
  const canRollback =
    !status?.incoming &&
    status?.moveId &&
    (status.phase === "active" || status.phase === "fenced" || status.phase === "staging");
  const owner = status?.ownerId;
  const ownerLabel =
    owner === LOCAL_AGENT_MACHINE
      ? localLabel
      : (machines.find((machine) => machine.id === owner)?.label ?? owner);
  return (
    <div className="flex max-w-md flex-col items-start gap-2 text-sm">
      {canPick ? (
        <label className="flex flex-col gap-1">
          <select
            aria-label="Coordinator runs on"
            className="rounded-md border bg-background px-2 py-1.5"
            disabled={busy || machines.length === 0}
            value={pending?.destinationId ?? review?.destination.id ?? LOCAL_AGENT_MACHINE}
            onChange={(event) => {
              const destination = machines.find(
                (machine) => machine.id === event.currentTarget.value,
              );
              if (destination)
                void execute(
                  { operation: "preflight", destinationId: destination.id },
                  destination,
                );
              else setReview(null);
            }}
          >
            <option value={LOCAL_AGENT_MACHINE}>{localLabel}</option>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        status && <strong>{paused ? "Coordinator paused" : ownerLabel}</strong>
      )}
      <p className="whitespace-pre-line text-xs text-muted-foreground" role="status">
        {pending
          ? {
              status: "Checking placement…",
              preflight: "Checking destination readiness…",
              move: "Moving coordinator…",
              retry: "Verifying the move…",
              rollback: "Rolling back the move…",
            }[pending.operation]
          : error || review?.check.detail || status?.detail}
      </p>
      {canPick && machines.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Link a machine in Settings to move this coordinator.
        </p>
      )}
      {approvalDigest && review && (
        <p className="text-xs text-muted-foreground">
          Moving pauses the coordinator while its conversation, Project state, Status, schedules,
          memory and agent associations are verified on {review.destination.label}.
        </p>
      )}
      {review && (
        <div className="flex flex-wrap gap-2">
          {approvalDigest && (
            <Button
              size="xs"
              onClick={() =>
                void execute({
                  operation: "move",
                  destinationId: review.destination.id,
                  approvalDigest,
                })
              }
            >
              Move coordinator to {review.destination.label}
            </Button>
          )}
          {!approvalDigest && (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void execute(
                  { operation: "preflight", destinationId: review.destination.id },
                  review.destination,
                )
              }
            >
              Check again
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={() => setReview(null)}>
            Cancel
          </Button>
        </div>
      )}
      {!busy && !rollback && (
        <div className="flex flex-wrap gap-2">
          {(!status || paused) && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void execute({ operation: "status" })}
            >
              Refresh status
            </Button>
          )}
          {!status?.incoming && paused && status?.moveId && (
            <Button
              size="xs"
              onClick={() => void execute({ operation: "retry", moveId: status.moveId! })}
            >
              Retry verification
            </Button>
          )}
          {canRollback && (
            <Button size="xs" variant="outline" onClick={() => setRollback(true)}>
              Roll back move
            </Button>
          )}
        </div>
      )}
      {rollback && status?.moveId && (
        <div className="space-y-2">
          <p>
            Restore the coordinator on {localLabel}? The move will pause execution and verify
            Project data before resuming here.
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              onClick={() => void execute({ operation: "rollback", moveId: status.moveId! })}
            >
              Confirm rollback
            </Button>
            <Button size="xs" variant="outline" onClick={() => setRollback(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
