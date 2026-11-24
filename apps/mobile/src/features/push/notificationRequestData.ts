// Fork-owned. The custom data of a delivered notification.
//
// expo-notifications reports a remote push's `content.data` as the APNs
// payload's `body` key only (NotificationRecords.swift,
// serializedNotificationData). Neither our server pushes (`cp`) nor the relay's
// agent pushes (top-level `deepLink`) send a `body`, so for them `content.data`
// is empty and the full APNs payload is only on the push trigger. Local
// notifications (the snooze repost) keep their data in `content.data`.

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

export function notificationRequestData(request: unknown): Record<string, unknown> | null {
  if (typeof request !== "object" || request === null) return null;
  const { content, trigger } = request as {
    readonly content?: unknown;
    readonly trigger?: unknown;
  };
  const data =
    typeof content === "object" && content !== null
      ? (content as { readonly data?: unknown }).data
      : undefined;
  if (isNonEmptyRecord(data)) return data;
  const payload =
    typeof trigger === "object" && trigger !== null
      ? (trigger as { readonly payload?: unknown }).payload
      : undefined;
  return isNonEmptyRecord(payload) ? payload : null;
}
