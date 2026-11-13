import {
  DEFAULT_PUSH_NOTIFICATION_LEVEL,
  PUSH_DEVICES_ROUTE_PATH,
  type PushApsEnvironment,
  type PushDeviceRegistration,
  type PushNotificationLevel,
} from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";

// Fork-owned. The phone tells each connected Mac where to send its iPhone
// notifications: its APNs token, and the server URL the phone reaches it at,
// which lock-screen answers post back to.

export interface PushRegistrationInput {
  readonly deviceId: string;
  readonly apnsToken: string;
  readonly apsEnvironment: PushApsEnvironment;
  readonly bundleId: string;
  readonly level: PushNotificationLevel | undefined;
  readonly label?: string;
}

/** Bearer connections only: a DPoP or relay-managed link cannot sign a plain POST here. */
export function canRegisterPushWith(connection: SavedRemoteConnection): boolean {
  return (
    connection.bearerToken !== null &&
    connection.authenticationMethod !== "dpop" &&
    connection.relayManaged !== true &&
    /^https?:\/\//.test(connection.httpBaseUrl)
  );
}

export function pushRegistrationBody(
  connection: Pick<SavedRemoteConnection, "httpBaseUrl">,
  input: PushRegistrationInput,
): PushDeviceRegistration {
  const level = input.level ?? DEFAULT_PUSH_NOTIFICATION_LEVEL;
  return {
    deviceId: input.deviceId,
    apnsToken: input.apnsToken,
    apsEnvironment: input.apsEnvironment,
    bundleId: input.bundleId,
    serverUrl: connection.httpBaseUrl.replace(/\/+$/, ""),
    level,
    ...(input.label === undefined ? {} : { label: input.label }),
    enabled: level !== "off",
  };
}

/** What a registration depends on; unchanged signatures are not re-sent. */
export function pushRegistrationSignature(body: PushDeviceRegistration): string {
  return JSON.stringify([body.apnsToken, body.serverUrl, body.level, body.apsEnvironment]);
}

export async function registerPushWithEnvironment(
  connection: SavedRemoteConnection,
  body: PushDeviceRegistration,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl(
    `${connection.httpBaseUrl.replace(/\/+$/, "")}${PUSH_DEVICES_ROUTE_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connection.bearerToken ?? ""}`,
      },
      body: JSON.stringify(body),
    },
  );
  return response.ok;
}
