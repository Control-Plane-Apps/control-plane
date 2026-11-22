import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveTaskEnvironmentId, type TaskEnvironmentCandidate } from "./taskEnvironment";

const MINI = "env-mini" as EnvironmentId;
const MACBOOK = "env-macbook" as EnvironmentId;
const OLD = "env-old" as EnvironmentId;

function candidate(
  environmentId: EnvironmentId,
  patch: Partial<Omit<TaskEnvironmentCandidate, "environmentId">> = {},
): TaskEnvironmentCandidate {
  return { environmentId, isPrimary: false, supportsTasks: true, taskRecordCount: 0, ...patch };
}

describe("resolveTaskEnvironmentId", () => {
  it("prefers the task authority over a primary that defers Tasks to it", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MACBOOK, { isPrimary: true, taskRecordCount: 9, defersTasks: true }),
          candidate(MINI, { taskRecordCount: 9 }),
        ],
        rememberedEnvironmentId: MACBOOK,
      }),
    ).toBe(MINI);
  });

  it("keeps a deferring server's Tasks when the authority is not connected", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MACBOOK, { isPrimary: true, taskRecordCount: 9, defersTasks: true }),
        ],
        rememberedEnvironmentId: null,
      }),
    ).toBe(MACBOOK);
  });

  it("keeps Tasks on the primary when it holds them", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MINI, { isPrimary: true, taskRecordCount: 3 }),
          candidate(MACBOOK, { taskRecordCount: 9 }),
        ],
        rememberedEnvironmentId: MACBOOK,
      }),
    ).toBe(MINI);
  });

  it("uses a remote server's tasks when the primary is empty", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MINI, { isPrimary: true }),
          candidate(MACBOOK, { taskRecordCount: 4 }),
        ],
        rememberedEnvironmentId: null,
      }),
    ).toBe(MACBOOK);
  });

  it("uses a remote server's tasks when the primary has not loaded its config", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MINI, { isPrimary: true, supportsTasks: null }),
          candidate(MACBOOK, { taskRecordCount: 4 }),
        ],
        rememberedEnvironmentId: null,
      }),
    ).toBe(MACBOOK);
  });

  it("stays on the remembered remote while it reconnects without a cached config", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MINI, { isPrimary: true }),
          candidate(MACBOOK, { supportsTasks: null }),
        ],
        rememberedEnvironmentId: MACBOOK,
      }),
    ).toBe(MACBOOK);
  });

  it("drops a remembered server that is gone or known to lack Tasks", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [
          candidate(MINI, { isPrimary: true }),
          candidate(OLD, { supportsTasks: false }),
        ],
        rememberedEnvironmentId: OLD,
      }),
    ).toBe(MINI);
    expect(
      resolveTaskEnvironmentId({
        candidates: [candidate(MINI, { isPrimary: true })],
        rememberedEnvironmentId: MACBOOK,
      }),
    ).toBe(MINI);
  });

  it("falls back to a capable remote when there is no capable primary", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [candidate(OLD, { supportsTasks: false }), candidate(MACBOOK)],
        rememberedEnvironmentId: null,
      }),
    ).toBe(MACBOOK);
  });

  it("returns null when no server supports Tasks", () => {
    expect(
      resolveTaskEnvironmentId({
        candidates: [candidate(OLD, { isPrimary: true, supportsTasks: false })],
        rememberedEnvironmentId: null,
      }),
    ).toBeNull();
  });
});
