import type {
  Task,
  TaskDeleteScope,
  TaskHandoff,
  TaskHorizon,
  TaskId,
  TaskPatch,
  TaskSyncStatus,
} from "@t3tools/contracts";
import type { HandoffDelivery } from "@t3tools/client-runtime/state/projects";
import type { LocalTaskInput } from "@t3tools/shared/taskSync/localTasks";

// Fork-owned. Where the phone's task list comes from, and how its writes are
// split between the phone's own Task Sync copy and the paired Mac. Pure (no
// React Native) so the rules are unit tested.
//
// Signed in to Task Sync, the phone's cloud copy is the one source of truth
// for tasks and intents: reads and writes go there, offline included (the
// engine's outbox persists and syncs later), whatever the Mac is doing. The
// Mac only adds what never syncs: links, hand-offs, proposals. Without Task
// Sync the Mac's snapshot is the list, as before.

export type MobileTaskSource = "mac" | "cloud";

/** The phone's Task Sync states in which its own copy is the source of truth. */
export function cloudTaskSourceActive(
  status: Pick<TaskSyncStatus, "state"> | null,
  savedAccount: boolean,
): boolean {
  // Before the engine has answered (launch), the saved account decides, so
  // Tasks render from the phone's copy instantly and never flash the Mac's.
  if (status === null) return savedAccount;
  return status.state === "synced" || status.state === "syncing" || status.state === "error";
}

/** The list's source: only Task Sync decides. The Mac's connection never switches it. */
export function selectTaskSource(cloudActive: boolean): MobileTaskSource {
  return cloudActive ? "cloud" : "mac";
}

/**
 * Cloud tasks with the Mac's Control Plane-only fields laid back on, plus the
 * Mac's proposals (and proposals it accepted that have not reached the cloud
 * yet), which exist only on the Mac. Mac copies of synced tasks never replace
 * the phone's: the phone's edits win until the Mac catches up.
 */
export function layerMacFields(
  cloud: ReadonlyArray<Task>,
  mac: ReadonlyArray<Task>,
): ReadonlyArray<Task> {
  if (mac.length === 0) return cloud;
  const macById = new Map(mac.map((task) => [task.id as string, task]));
  const cloudIds = new Set<string>();
  const layered = cloud.map((task) => {
    cloudIds.add(task.id);
    const known = macById.get(task.id);
    if (known === undefined) return task;
    return {
      ...task,
      ...(known.links !== undefined ? { links: known.links } : {}),
      ...(known.handoff !== undefined ? { handoff: known.handoff } : {}),
      ...(known.proposal !== undefined ? { proposal: known.proposal } : {}),
      ...(known.importSource !== undefined ? { importSource: known.importSource } : {}),
      ...(known.completionPromptDismissedAt !== undefined
        ? { completionPromptDismissedAt: known.completionPromptDismissedAt }
        : {}),
    };
  });
  const macOnly = mac.filter((task) => !cloudIds.has(task.id) && task.proposal !== undefined);
  return macOnly.length === 0 ? layered : [...layered, ...macOnly];
}

/** Fields only the Mac stores; everything else is the cloud's. */
const MAC_ONLY_PATCH_KEYS = ["links", "completionPromptDismissedAt"] as const;

export function splitTaskPatch(patch: TaskPatch): {
  readonly cloud: TaskPatch | null;
  readonly mac: TaskPatch | null;
} {
  const cloud: Record<string, unknown> = {};
  const mac: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((MAC_ONLY_PATCH_KEYS as ReadonlyArray<string>).includes(key)) mac[key] = value;
    else cloud[key] = value;
  }
  return {
    cloud: Object.keys(cloud).length === 0 ? null : (cloud as TaskPatch),
    mac: Object.keys(mac).length === 0 ? null : (mac as TaskPatch),
  };
}

export const NEEDS_MAC_MESSAGE =
  "This needs your Mac, and it isn't reachable right now. Your task changes are saved on this iPhone and sync on their own.";
export const WAITING_FOR_SYNC_MESSAGE =
  "Your latest task changes haven't synced yet. Try again once this iPhone is online.";
export const MAC_CATCHING_UP_MESSAGE =
  "Your Mac hasn't received this task yet. Try again in a moment.";

/** The phone's cloud copy, as the actions need it (CloudTaskStore). */
export interface CloudTaskWriter {
  has(taskId: TaskId): boolean;
  create(input: LocalTaskInput): Promise<void>;
  patch(taskId: TaskId, patch: TaskPatch): Promise<boolean>;
  delete(taskId: TaskId, scope?: TaskDeleteScope): Promise<void>;
  setIntent(horizon: TaskHorizon, startsOn: string, text: string): Promise<void>;
  /** Push and pull now; resolves with the status after. */
  syncNow(): Promise<Pick<TaskSyncStatus, "pendingChanges">>;
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly message?: string };

/** The paired Mac, for what only it holds. Writes resolve to an outcome, never throw. */
export interface MacTaskBridge {
  /** Reachable right now (connected). */
  readonly connected: boolean;
  /** Whether the Mac's current snapshot has the task. */
  knows(taskId: TaskId): boolean;
  /** Asks the Mac to sync with the cloud now (push, then pull). */
  syncNow(): Promise<void>;
  /** Resolves once `taskId` is in the Mac's snapshot, or false after a short wait. */
  waitFor(taskId: TaskId): Promise<boolean>;
  update(taskId: TaskId, patch: TaskPatch): Promise<Outcome>;
  remove(taskId: TaskId, scope?: TaskDeleteScope): Promise<Outcome>;
  respond(taskId: TaskId, accept: boolean): Promise<Outcome>;
  handOff(
    taskId: TaskId,
    handoff: TaskHandoff | null,
    delivery?: HandoffDelivery,
  ): Promise<Outcome>;
}

export interface CloudTaskActionDeps {
  readonly cloud: CloudTaskWriter;
  readonly mac: MacTaskBridge;
  readonly alert: (title: string, message: string) => void;
  readonly newId: () => TaskId;
}

export interface NewTaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly home: LocalTaskInput["home"];
  readonly recurrence?: LocalTaskInput["recurrence"];
  readonly links?: Task["links"];
}

type TaskRef = Pick<Task, "id" | "title">;

/**
 * Task writes with the phone's cloud copy as the source of truth. Cloud
 * fields write locally (offline-safe, queued in the engine's outbox). Mac-only
 * writes (links, hand-offs, proposals) need the Mac reachable; before one,
 * the phone pushes its own edits and the Mac pulls, so the Mac's whole-row
 * write can never carry stale fields back over the phone's newer ones.
 */
export function makeCloudTaskActions(deps: CloudTaskActionDeps) {
  const { cloud, mac, alert } = deps;

  const guarded = async (title: string, run: () => Promise<unknown>): Promise<boolean> => {
    try {
      return (await run()) !== false;
    } catch {
      alert(title, "Try again in a moment.");
      return false;
    }
  };

  const finish = (title: string, outcome: Outcome): boolean => {
    if (outcome.ok) return true;
    if (outcome.message !== undefined) alert(title, outcome.message);
    return false;
  };

  /** Gets the Mac level with the cloud for `taskId`, or explains why not. */
  const readyOnMac = async (title: string, taskId: TaskId): Promise<boolean> => {
    if (!mac.connected) {
      alert(title, NEEDS_MAC_MESSAGE);
      return false;
    }
    // A proposal lives only on the Mac: nothing of the phone's to carry over.
    if (!cloud.has(taskId)) return true;
    const status = await cloud.syncNow().catch(() => ({ pendingChanges: 1 }));
    if (status.pendingChanges > 0) {
      alert(title, WAITING_FOR_SYNC_MESSAGE);
      return false;
    }
    await mac.syncNow().catch(() => undefined);
    if (!mac.knows(taskId) && !(await mac.waitFor(taskId))) {
      alert(title, MAC_CATCHING_UP_MESSAGE);
      return false;
    }
    return true;
  };

  const macWrite = async (
    title: string,
    taskId: TaskId,
    run: () => Promise<Outcome>,
  ): Promise<boolean> => {
    if (!(await readyOnMac(title, taskId))) return false;
    const ok = finish(title, await run());
    // The Mac pushes its write; bring it back so the phone's copy matches.
    if (ok) void cloud.syncNow().catch(() => undefined);
    return ok;
  };

  const patch = async (task: TaskRef, value: TaskPatch, title?: string): Promise<boolean> => {
    const label = title ?? `Could not update ${task.title}`;
    // Not in the phone's copy: a proposal or a task only the Mac has.
    if (!cloud.has(task.id)) {
      if (!mac.knows(task.id)) return false;
      return macWrite(label, task.id, () => mac.update(task.id, value));
    }
    const split = splitTaskPatch(value);
    if (split.cloud !== null) {
      const ok = await guarded(label, () => cloud.patch(task.id, split.cloud!));
      if (!ok) return false;
    }
    if (split.mac === null) return true;
    return macWrite(label, task.id, () => mac.update(task.id, split.mac!));
  };

  return {
    available: true,
    /** Whether the Mac-only actions (hand-offs, proposals, links) can run now. */
    macReachable: mac.connected,
    create: async (input: NewTaskInput): Promise<TaskId | null> => {
      const taskId = deps.newId();
      const ok = await guarded("Could not add the task", () =>
        cloud.create({
          id: taskId,
          title: input.title,
          home: input.home,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
        }),
      );
      if (!ok) return null;
      if (input.links !== undefined) {
        // The task is saved; its project link follows through the Mac.
        void macWrite(`Added ${input.title}, but couldn't link it`, taskId, () =>
          mac.update(taskId, { links: input.links! }),
        );
      }
      return taskId;
    },
    patch,
    setCompleted: (task: TaskRef, completed: boolean) =>
      patch(
        task,
        { status: completed ? "completed" : "todo" },
        completed ? `Could not complete ${task.title}` : `Could not reopen ${task.title}`,
      ),
    move: (task: TaskRef, home: Task["home"]) =>
      patch(task, { home }, `Could not move ${task.title}`),
    delete: async (task: TaskRef, scope?: TaskDeleteScope): Promise<boolean> => {
      const title = `Could not delete ${task.title}`;
      if (!cloud.has(task.id) && mac.knows(task.id)) {
        return macWrite(title, task.id, () => mac.remove(task.id, scope));
      }
      return guarded(title, () => cloud.delete(task.id, scope));
    },
    respond: async (task: TaskRef, accept: boolean): Promise<boolean> => {
      const title = accept ? `Could not add ${task.title}` : `Could not dismiss ${task.title}`;
      if (!mac.connected) {
        alert(title, NEEDS_MAC_MESSAGE);
        return false;
      }
      const ok = finish(title, await mac.respond(task.id, accept));
      // The accepted task reaches the cloud from the Mac; fetch it now.
      if (ok && accept) {
        void mac
          .syncNow()
          .then(() => cloud.syncNow())
          .catch(() => undefined);
      }
      return ok;
    },
    handOff: (task: TaskRef, handoff: TaskHandoff | null, delivery?: HandoffDelivery) =>
      macWrite(`Could not hand off ${task.title}`, task.id, () =>
        mac.handOff(task.id, handoff, delivery),
      ),
    setIntent: (horizon: TaskHorizon, startsOn: string, text: string) =>
      guarded("Could not save the intent", () => cloud.setIntent(horizon, startsOn, text)),
  };
}

export type CloudTaskActions = ReturnType<typeof makeCloudTaskActions>;
