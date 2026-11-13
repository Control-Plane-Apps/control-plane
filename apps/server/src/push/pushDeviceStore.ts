/**
 * The phones registered for push on this Mac, and which Status question
 * versions were already sent, in `<stateDir>/push/devices.json`. Fork-owned.
 *
 * @module pushDeviceStore
 */
import * as Schema from "effect/Schema";

import { PushApsEnvironment, PushNotificationLevel } from "@t3tools/contracts";

export const StoredPushDevice = Schema.Struct({
  deviceId: Schema.String,
  apnsToken: Schema.String,
  apsEnvironment: PushApsEnvironment,
  bundleId: Schema.String,
  serverUrl: Schema.String,
  level: PushNotificationLevel,
  label: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type StoredPushDevice = typeof StoredPushDevice.Type;

export const PushStoreFile = Schema.Struct({
  version: Schema.Literal(1),
  devices: Schema.Array(StoredPushDevice),
  /** `<projectId>:<statusId>` to the `openedAt` last sent, so a restart never resends one. */
  sentQuestions: Schema.Record(Schema.String, Schema.String),
});
export type PushStoreFile = typeof PushStoreFile.Type;

export const EMPTY_PUSH_STORE: PushStoreFile = { version: 1, devices: [], sentQuestions: {} };

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PushStoreFile));
const encode = Schema.encodeSync(Schema.fromJsonString(PushStoreFile));

export function parsePushStore(json: string): PushStoreFile {
  const parsed = decode(json);
  return parsed._tag === "Some" ? parsed.value : EMPTY_PUSH_STORE;
}

export function serializePushStore(store: PushStoreFile): string {
  return encode(store);
}

/** Upserts by device id; a token now owned by another install moves to it. */
export function upsertDevice(store: PushStoreFile, device: StoredPushDevice): PushStoreFile {
  return {
    ...store,
    devices: [
      ...store.devices.filter(
        (entry) => entry.deviceId !== device.deviceId && entry.apnsToken !== device.apnsToken,
      ),
      device,
    ],
  };
}

export function removeDevice(
  store: PushStoreFile,
  match: { readonly deviceId?: string; readonly apnsToken?: string },
): PushStoreFile {
  return {
    ...store,
    devices: store.devices.filter(
      (entry) => entry.deviceId !== match.deviceId && entry.apnsToken !== match.apnsToken,
    ),
  };
}

/** Bound the sent-question map so it cannot grow forever. */
export function recordSentQuestion(
  store: PushStoreFile,
  key: string,
  openedAt: string,
  limit = 500,
): PushStoreFile {
  const entries = Object.entries(store.sentQuestions).filter(([existing]) => existing !== key);
  entries.push([key, openedAt]);
  return { ...store, sentQuestions: Object.fromEntries(entries.slice(-limit)) };
}
