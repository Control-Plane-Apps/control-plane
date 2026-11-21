import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { startConnectionStatusGrace } from "./connection-status-grace";

/** Every foreground launch gets quiet time; phone network loss is immediate. */
export function useConnectionStatusVisible(
  pending: boolean,
  offline: boolean,
  scope: string | null = null,
): boolean {
  const [status, setStatus] = useState({ scope, visible: false });
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const restart = () => {
      cancel?.();
      cancel = startConnectionStatusGrace({
        pending,
        offline,
        active: AppState.currentState === "active",
        show: (visible) => setStatus({ scope, visible }),
      });
    };
    restart();
    const subscription = AppState.addEventListener("change", restart);
    return () => {
      cancel?.();
      subscription.remove();
    };
  }, [pending, offline, scope]);
  return pending && (offline || (status.scope === scope && status.visible));
}
