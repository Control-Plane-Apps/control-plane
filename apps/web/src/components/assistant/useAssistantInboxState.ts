import type { AssistantPing } from "@t3tools/client-runtime/state/assistant-home";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

// Read state is local to this client, scoped by environment and thread.
export function useAssistantInboxState(key: string, pings: ReadonlyArray<AssistantPing>) {
  const [readThrough, setReadThrough] = useLocalStorage(
    `cplane:assistant-inbox-read:v1:${key}`,
    "",
    Schema.String,
  );
  const newestPing = pings[0]?.createdAt ?? "";
  return {
    unreadCount: pings.filter((ping) => ping.createdAt > readThrough).length,
    onOpenChange: (open: boolean) => {
      if (open && newestPing > readThrough) setReadThrough(newestPing);
    },
  };
}
