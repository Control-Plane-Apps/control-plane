/**
 * A scripted `Reach` for tests: one linked machine per entry, each answering
 * ops from a handler or failing as offline. Records every call.
 *
 * @module testReach
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Reach, ReachError, unlinkedReach, type ReachShape } from "./Reach.ts";
import type { OverviewResult, ReachOp } from "./reachProtocol.ts";

export interface ScriptedMachine {
  readonly id: string;
  readonly label: string;
  online: boolean;
  readonly answer: (op: ReachOp, input: unknown) => unknown;
}

export interface ReachCall {
  readonly machineId: string;
  readonly op: ReachOp;
  readonly input: unknown;
}

export function makeScriptedReach(machines: ReadonlyArray<ScriptedMachine>) {
  const calls: Array<ReachCall> = [];
  const lastOverview = new Map<string, OverviewResult>();
  const offline = (machine: { id: string; label: string }) =>
    new ReachError({
      kind: "offline",
      machineId: machine.id,
      machineLabel: machine.label,
      detail: `${machine.label} is offline. Nothing was sent; try again when it is awake.`,
    });
  const find = (id: string) => machines.find((machine) => machine.id === id);

  const call: ReachShape["call"] = (machine, op, input, _caller, result) =>
    Effect.gen(function* () {
      calls.push({ machineId: machine.id, op, input });
      const scripted = find(machine.id);
      if (scripted === undefined || !scripted.online) return yield* offline(machine);
      const raw = (() => {
        try {
          return { ok: true as const, value: scripted.answer(op, input) };
        } catch (error) {
          return { ok: false as const, error: String((error as Error).message) };
        }
      })();
      if (!raw.ok) {
        return yield* new ReachError({
          kind: "refused",
          machineId: machine.id,
          machineLabel: machine.label,
          detail: raw.error,
        });
      }
      return yield* Schema.decodeUnknownEffect(result)(raw.value).pipe(Effect.orDie);
    });

  const service: ReachShape = {
    ...unlinkedReach,
    machines: Effect.sync(() => machines.map(({ id, label }) => ({ id, label }))),
    healthOf: (id) =>
      Effect.sync(() => ({
        status: find(id)?.online === true ? "connected" : "offline",
        detail: null,
        lastSeenAt: find(id)?.online === true ? null : "2026-11-21T08:00:00.000Z",
      })),
    self: Effect.succeed({ environmentId: "env-mini", label: "Mac mini" }),
    call,
    overview: (machine, caller) =>
      call(machine, "overview", {}, caller, Schema.Unknown).pipe(
        Effect.map((result) => {
          lastOverview.set(machine.id, result as OverviewResult);
          return { result: result as OverviewResult, at: "2026-11-21T09:00:00.000Z" };
        }),
        Effect.mapError((error) => ({ error, lastKnown: lastOverview.get(machine.id) ?? null })),
      ),
    locateProject: (projectId) =>
      Effect.sync(() => {
        for (const machine of machines) {
          const project = (machine.answer("overview", {}) as OverviewResult).projects.find(
            (entry) => entry.projectId === projectId,
          );
          if (project !== undefined) {
            return Option.some({ machine: { id: machine.id, label: machine.label }, project });
          }
        }
        return Option.none();
      }),
    locateThread: () => Effect.succeedNone,
    findAssistant: Effect.sync(() => {
      for (const machine of machines) {
        if (!machine.online) continue;
        const described = machine.answer("describe", {}) as {
          assistant: { threadId: string; projectId: string } | null;
        };
        if (described.assistant !== null) {
          return Option.some({
            machineId: machine.id,
            machineLabel: machine.label,
            threadId: described.assistant.threadId,
            projectId: described.assistant.projectId,
          });
        }
      }
      return Option.none();
    }),
  };

  return { calls, service, layer: Layer.succeed(Reach, service) };
}
