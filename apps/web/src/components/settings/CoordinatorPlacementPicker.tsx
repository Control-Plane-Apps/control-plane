import {
  LOCAL_AGENT_MACHINE,
  type CoordinatorCheckoutOption,
  type CoordinatorMoveInput,
  type CoordinatorMoveStatus,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { agentMachinesErrorMessage } from "./AgentMachinesSettings.logic";

export type CoordinatorMoveRequest = Omit<CoordinatorMoveInput, "action" | "projectId">;
type Machine = { readonly id: string; readonly label: string };

type CheckoutChoice = {
  machine: Machine;
  sources: readonly CoordinatorCheckoutOption[];
  destinations: readonly CoordinatorCheckoutOption[];
  sourceId: string;
  targetId: string;
};

function matches(choice: CheckoutChoice, sourceId: string) {
  const source = choice.sources.find((entry) => entry.projectId === sourceId);
  return source
    ? choice.destinations.filter((entry) => entry.repository === source.repository)
    : [];
}
function chooseSource(choice: CheckoutChoice, sourceId: string): CheckoutChoice {
  if (!choice.sources.some((entry) => entry.projectId === sourceId && !entry.blockedReason))
    return { ...choice, sourceId: "", targetId: "" };
  const eligible = matches(choice, sourceId).filter((entry) => !entry.blockedReason);
  return { ...choice, sourceId, targetId: eligible.length === 1 ? eligible[0]!.projectId : "" };
}
function preflight(choice: CheckoutChoice): CoordinatorMoveRequest {
  return {
    operation: "preflight",
    destinationId: choice.machine.id,
    sourceCheckoutProjectId: choice.sourceId,
    destinationProjectId: choice.targetId,
  };
}
function BlockedCheckouts({ entries }: { entries: readonly CoordinatorCheckoutOption[] }) {
  return entries
    .filter((entry) => entry.blockedReason)
    .map((entry) => (
      <p key={entry.projectId} className="break-words text-xs text-muted-foreground">
        {entry.title} ({entry.workspaceRoot}). {entry.blockedReason}
      </p>
    ));
}
export function CoordinatorPlacementPicker({
  localLabel,
  projectKey,
  projectId,
  machines,
  run,
}: {
  projectKey: string;
  projectId: string;
  localLabel: string;
  machines: readonly Machine[];
  run: (request: CoordinatorMoveRequest) => Promise<CoordinatorMoveStatus>;
}) {
  const receiptKey = "coordinator-move:" + projectKey;
  const [status, setStatus] = useState<CoordinatorMoveStatus | null>(null);
  const [choice, setChoice] = useState<CheckoutChoice | null>(null);
  const [review, setReview] = useState<{
    destination: Machine;
    check: CoordinatorMoveStatus;
    request: CoordinatorMoveRequest;
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
      if (request.operation === "options" || request.operation === "status") setChoice(null);
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
        let response = await run(request);
        if (sequence !== requestId.current) return;
        if (request.operation === "options" && destination) {
          if (!response.sourceCheckouts || !response.destinationProjects)
            throw new Error("The server did not provide registered checkout choices.");
          const sources = response.sourceCheckouts;
          const destinations = response.destinationProjects;
          const selected = chooseSource(
            { machine: destination, sources, destinations, sourceId: "", targetId: "" },
            projectId,
          );
          setChoice(selected);
          if (!selected.targetId) return;
          request = preflight(selected);
          setPending(request);
          response = await run(request);
          if (sequence !== requestId.current) return;
        }
        if (response.phase === "rolled-back" && response.destinationId) {
          const key = receiptKey + ":" + response.destinationId;
          if (response.moveId && localStorage.getItem(key)?.endsWith("\n" + response.moveId)) {
            localStorage.removeItem(key);
          }
        }
        if (destination) setReview({ destination, check: response, request });
        else {
          setChoice(null);
          setStatus(response);
        }
      } catch (cause) {
        if (sequence !== requestId.current) return;
        const message = agentMachinesErrorMessage(cause);
        setError(
          request.operation === "options"
            ? message +
                " Check the link and update both environments to a version with checkout selection, then choose the destination again."
            : message,
        );
        if (request.operation !== "preflight" && request.operation !== "options") setStatus(null);
      } finally {
        if (sequence === requestId.current) setPending(null);
      }
    },
    [run, receiptKey, projectId],
  );

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Read the server's durable receipt whenever this Project is opened.
    void execute({ operation: "status" });
    return () => {
      requestId.current++;
    };
  }, [execute]);

  const resetSelection = () => {
    requestId.current++;
    setChoice(null);
    setReview(null);
    setPending(null);
    setError("");
  };
  const selectCheckout = (selected: CheckoutChoice) => {
    setChoice(selected);
    setReview(null);
    setError("");
    if (selected.targetId) void execute(preflight(selected), selected.machine);
  };
  const targets = choice ? matches(choice, choice.sourceId) : [];
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
    <div className="flex w-full min-w-0 max-w-md flex-col items-start gap-2 text-sm">
      {canPick ? (
        <label className="flex flex-col gap-1">
          <select
            aria-label="Coordinator runs on"
            className="rounded-md border bg-background px-2 py-1.5"
            disabled={busy || machines.length === 0}
            value={pending?.destinationId ?? choice?.machine.id ?? LOCAL_AGENT_MACHINE}
            onChange={(event) => {
              const destination = machines.find(
                (machine) => machine.id === event.currentTarget.value,
              );
              if (destination)
                void execute({ operation: "options", destinationId: destination.id }, destination);
              else resetSelection();
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
      {canPick && choice && (
        <div className="flex w-full min-w-0 flex-col gap-2">
          <label className="flex flex-col gap-1">
            Source checkout
            <select
              aria-label="Source checkout"
              className="w-full rounded-md border bg-background px-2 py-1.5"
              value={choice.sourceId}
              disabled={busy || !choice.sources.length}
              onChange={(event) => selectCheckout(chooseSource(choice, event.currentTarget.value))}
            >
              <option value="">Choose a registered checkout</option>
              {choice.sources.map((entry) => (
                <option
                  key={entry.projectId}
                  value={entry.projectId}
                  disabled={!!entry.blockedReason}
                >
                  {entry.title} · {entry.workspaceRoot}
                </option>
              ))}
            </select>
          </label>
          <BlockedCheckouts entries={choice.sources} />
          {!choice.sources.length && (
            <p className="text-xs text-muted-foreground">
              Register a Git checkout on {localLabel} to move this coordinator.
            </p>
          )}
          {choice.sourceId && (
            <>
              <label className="flex flex-col gap-1">
                Destination Project
                <select
                  aria-label="Destination Project"
                  className="w-full rounded-md border bg-background px-2 py-1.5"
                  value={choice.targetId}
                  disabled={busy || !targets.length}
                  onChange={(event) =>
                    selectCheckout({ ...choice, targetId: event.currentTarget.value })
                  }
                >
                  <option value="">Choose an empty Project</option>
                  {targets.map((entry) => (
                    <option
                      key={entry.projectId}
                      disabled={!!entry.blockedReason}
                      value={entry.projectId}
                    >
                      {entry.title} · {entry.workspaceRoot}
                    </option>
                  ))}
                </select>
              </label>
              {!targets.length && (
                <p className="text-xs text-muted-foreground">
                  Register an empty Project for this repository on {choice.machine.label}.
                </p>
              )}
              <BlockedCheckouts entries={targets} />
            </>
          )}
        </div>
      )}
      <p className="whitespace-pre-line text-xs text-muted-foreground" role="status">
        {pending
          ? {
              status: "Checking placement…",
              options: "Loading registered checkouts…",
              preflight: "Checking destination readiness…",
              move: "Moving coordinator…",
              retry: "Verifying the move…",
              rollback: "Rolling back the move…",
            }[pending.operation]
          : error || review?.check.detail || (choice ? "" : status?.detail)}
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
                  ...review.request,
                  operation: "move",
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
              onClick={() => void execute(review.request, review.destination)}
            >
              Check again
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={resetSelection}>
            Cancel
          </Button>
        </div>
      )}
      {canPick && choice && !review && !busy && (
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void execute(
                { operation: "options", destinationId: choice.machine.id },
                choice.machine,
              )
            }
          >
            Refresh checkouts
          </Button>
          <Button size="xs" variant="outline" onClick={resetSelection}>
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
