/**
 * Commitment rollover over synced planning records, by the rule agreed with
 * Lucive so both apps move the same commitments the same way. Pure: it
 * reads the mirror and says which commitments to retire and which to create;
 * the engine writes them. Task rows are never touched, so a rollover cannot
 * clobber a concurrent edit to the task under whole-row last-writer-wins.
 */
import { taskPeriodFor, type TaskHorizon } from "@t3tools/contracts";

import type { WireMembershipFull, WirePeriodFull, WireTaskWithSeq } from "./cloudClient.ts";

export interface CommitmentRolloverInput {
  readonly tasks: ReadonlyArray<WireTaskWithSeq>;
  readonly periods: ReadonlyArray<WirePeriodFull>;
  readonly memberships: ReadonlyArray<WireMembershipFull>;
}

export interface RolledCommitment {
  readonly taskId: string;
  readonly horizon: TaskHorizon;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly sortOrder: number;
}

export interface CommitmentRolloverPlan {
  /** Live memberships to tombstone. */
  readonly retire: ReadonlyArray<WireMembershipFull>;
  /** New commitments on the current period of the same horizon. */
  readonly create: ReadonlyArray<RolledCommitment>;
}

type PlanningPeriod = WirePeriodFull & { readonly horizon: TaskHorizon };

function isPlanningPeriod(period: WirePeriodFull | undefined): period is PlanningPeriod {
  return period !== undefined && period.deletedAt === null && period.horizon !== "day";
}

/**
 * What a rollover on `today` does. A live commitment on an open week, month
 * or year that ended before `today` belongs to a plain todo task (not
 * deleted, not a template, not a recurring instance). Then:
 * - a dated task keeps its date: the membership retires, nothing replaces it;
 * - a backlog placement newer than the membership retires it the same way;
 * - so does another live commitment on a period that has not ended;
 * - otherwise it moves to the current period of its horizon, unless that
 *   period exists and is closed, or would not start after the source period
 *   (a device behind does nothing). Then the source stays as it is.
 * Completed, cancelled and recurring tasks, and closed source periods, are
 * left alone. New commitments append after the target period's live
 * memberships, keeping the rolled tasks' source order, per target period.
 */
export function planCommitmentRollover(
  input: CommitmentRolloverInput,
  today: string,
  weekStartsOn: number,
): CommitmentRolloverPlan {
  const periodsById = new Map(input.periods.map((period) => [period.id, period]));
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const live = input.memberships.filter(
    (membership) => membership.role === "commitment" && membership.deletedAt === null,
  );
  const placed = new Set<string>();
  const expired: Array<{ membership: WireMembershipFull; period: PlanningPeriod }> = [];
  for (const membership of live) {
    const period = periodsById.get(membership.periodId);
    if (!isPlanningPeriod(period)) continue;
    if (period.endsOn >= today) placed.add(membership.taskId);
    else if (period.state === "open") expired.push({ membership, period });
  }
  // When a task holds several expired commitments, the latest-ending one rolls
  // and the rest retire behind it.
  expired.sort(
    (a, b) =>
      b.period.endsOn.localeCompare(a.period.endsOn) ||
      a.membership.sortOrder - b.membership.sortOrder ||
      a.membership.id.localeCompare(b.membership.id),
  );

  const naturalPeriod = (horizon: TaskHorizon, startsOn: string) =>
    input.periods.find(
      (period) =>
        period.horizon === horizon && period.startsOn === startsOn && period.deletedAt === null,
    );

  const retire: WireMembershipFull[] = [];
  const moves = new Map<
    string,
    {
      horizon: TaskHorizon;
      startsOn: string;
      endsOn: string;
      existing: WirePeriodFull | undefined;
      rolled: WireMembershipFull[];
    }
  >();
  for (const { membership, period } of expired) {
    const task = tasksById.get(membership.taskId);
    if (
      task === undefined ||
      task.deletedAt !== null ||
      task.status !== "todo" ||
      task.isTemplate ||
      task.templateId !== null ||
      (task.recurrence !== null && task.recurrence !== undefined)
    ) {
      continue;
    }
    const newerBacklog =
      task.backlogHorizon !== null &&
      task.backlogHorizon !== undefined &&
      task.updatedAt > membership.updatedAt;
    if (task.scheduledDate !== null || newerBacklog || placed.has(task.id)) {
      retire.push(membership);
      continue;
    }
    const target = taskPeriodFor(period.horizon, today, weekStartsOn);
    if (target.startsOn <= period.startsOn) continue;
    const key = `${period.horizon}:${target.startsOn}`;
    let move = moves.get(key);
    if (move === undefined) {
      move = {
        horizon: period.horizon,
        startsOn: target.startsOn,
        endsOn: target.endsOn,
        existing: naturalPeriod(period.horizon, target.startsOn),
        rolled: [],
      };
      moves.set(key, move);
    }
    if (move.existing !== undefined && move.existing.state !== "open") continue;
    retire.push(membership);
    move.rolled.push(membership);
    placed.add(task.id);
  }

  const create: RolledCommitment[] = [];
  for (const move of moves.values()) {
    if (move.rolled.length === 0) continue;
    const targetId = move.existing?.id;
    let last = -1;
    for (const membership of input.memberships) {
      if (membership.periodId === targetId && membership.deletedAt === null) {
        last = Math.max(last, membership.sortOrder);
      }
    }
    const ordered = [...move.rolled].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.taskId.localeCompare(b.taskId),
    );
    ordered.forEach((membership, index) =>
      create.push({
        taskId: membership.taskId,
        horizon: move.horizon,
        startsOn: move.startsOn,
        endsOn: move.endsOn,
        sortOrder: last + 1 + index,
      }),
    );
  }
  return { retire, create };
}
