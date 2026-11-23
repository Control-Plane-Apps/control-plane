import { ActivityIndicator, Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useStatusRefresh, type StatusRefresh } from "./useStatusRefresh";

// Fork-owned. The Status header's refresh icon: asks the coordinator to
// refresh the board. A spinner stands in for the glyph while asked, and the
// icon dims when the coordinator's machine is away (the hint says why).

export const STATUS_REFRESH_LABEL = "Ask for a status refresh";

export function StatusRefreshButton(props: {
  readonly refresh: StatusRefresh;
  /** `filled` matches the phone's round Close button; `plain` the iPad pane's. */
  readonly variant: "filled" | "plain";
}) {
  const { asked, blockedReason, request } = props.refresh;
  const inert = asked || blockedReason !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={STATUS_REFRESH_LABEL}
      accessibilityHint={
        blockedReason ?? (asked ? "Asked. Waiting for the coordinator" : undefined)
      }
      accessibilityState={{ disabled: inert, busy: asked }}
      onPress={() => {
        if (!inert) request();
      }}
      className={cn(
        "size-11 items-center justify-center",
        props.variant === "filled" && "rounded-full bg-subtle-strong",
        blockedReason !== null && "opacity-40",
      )}
    >
      {asked ? (
        <ActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.clockwise"
          size={15}
          tintColorClassName={
            props.variant === "filled" ? "accent-foreground" : "accent-icon-muted"
          }
          type="monochrome"
          weight="semibold"
        />
      )}
    </Pressable>
  );
}

/** The icon wired to one Project's coordinator. */
export function ProjectStatusRefreshButton(props: {
  readonly project: EnvironmentProject;
  readonly variant: "filled" | "plain";
}) {
  const refresh = useStatusRefresh(props.project);
  return <StatusRefreshButton refresh={refresh} variant={props.variant} />;
}
