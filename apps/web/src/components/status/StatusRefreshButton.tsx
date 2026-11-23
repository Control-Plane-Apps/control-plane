import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { StatusRefresh } from "./useStatusRefresh";

// Fork-owned. The Status header's one icon: asks the coordinator to refresh
// the board. Spins while asked, and stays focusable but inert when the
// coordinator's machine is away so the tooltip can say why.

export const STATUS_REFRESH_LABEL = "Ask for a status refresh";

export function StatusRefreshButton(props: { readonly refresh: StatusRefresh }) {
  const { asked, blockedReason, request } = props.refresh;
  const inert = asked || blockedReason !== null;
  const tooltip =
    blockedReason ?? (asked ? "Asked. Waiting for the coordinator" : STATUS_REFRESH_LABEL);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn(
              "text-muted-foreground hover:text-foreground",
              blockedReason !== null && "opacity-50",
            )}
            aria-label={STATUS_REFRESH_LABEL}
            aria-disabled={inert}
            aria-busy={asked}
            data-testid="status-refresh"
            data-asked={asked ? "" : undefined}
            onClick={() => {
              if (!inert) request();
            }}
          >
            <RefreshIcon refreshing={asked} />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
