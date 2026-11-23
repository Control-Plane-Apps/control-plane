import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useTaskSync } from "../../state/taskSync";
import { Badge } from "../ui/badge";
import { taskSyncStateLabel, type TaskSyncServerRow } from "./taskSyncServers.logic";

function ServerRow(props: {
  readonly row: TaskSyncServerRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  // Each row reads its own server's status (and keeps it fresh for the page).
  const sync = useTaskSync(props.row.environmentId);
  const status = sync.status;
  const authority = status?.authority;
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 text-left",
        props.selected ? "border-primary/60 bg-accent/40" : "border-border hover:bg-accent/20",
      )}
    >
      <span className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium">{props.row.label}</span>
        {props.row.isPrimary ? (
          <span className="text-muted-foreground text-xs">this machine</span>
        ) : null}
        {authority?.authority === true ? (
          <Badge size="sm" variant="success">
            Holds your tasks
          </Badge>
        ) : null}
        {authority?.assistantHere === true ? (
          <Badge size="sm" variant="info">
            Runs the Assistant
          </Badge>
        ) : null}
        {authority?.rolls === true ? (
          <Badge size="sm" variant="secondary">
            Rolls commitments
          </Badge>
        ) : null}
        {authority?.signInNeeded === true ? (
          <Badge size="sm" variant="warning">
            Needs sign-in
          </Badge>
        ) : null}
      </span>
      <span className="text-muted-foreground text-xs">
        {taskSyncStateLabel(status)}
        {status?.account?.email !== undefined ? ` · ${status.account.email}` : ""}
        {authority !== undefined && !authority.authority && authority.deferTo !== undefined
          ? ` · tasks held by ${authority.deferTo.label}`
          : ""}
      </span>
    </button>
  );
}

/**
 * Every connected server that keeps Tasks, with its Task Sync state and role.
 * Each server signs in on its own; choosing one points the card below at it.
 */
export function TaskSyncServers(props: {
  readonly rows: ReadonlyArray<TaskSyncServerRow>;
  readonly selected: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  if (props.rows.length < 2) return null;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Servers">
      {props.rows.map((row) => (
        <ServerRow
          key={row.environmentId}
          row={row}
          selected={row.environmentId === props.selected}
          onSelect={() => props.onSelect(row.environmentId)}
        />
      ))}
    </div>
  );
}
