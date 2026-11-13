import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Fork-owned. The cross-Project Assistant's server settings: what it can see
// and what it may do for the user. The Assistant itself is a Project whose
// marker has `scope: "global"`; its coordinator thread is the Assistant
// conversation. Imports only effect so settings.ts can import this module
// without a cycle.

/** What the Assistant may do with workspace threads outside every Project. */
export const AssistantWorkspaceReach = Schema.Literals(["off", "read"]);
export type AssistantWorkspaceReach = typeof AssistantWorkspaceReach.Type;

/** What the Assistant may do with the user's tasks. */
export const AssistantTaskReach = Schema.Literals(["off", "read", "edit"]);
export type AssistantTaskReach = typeof AssistantTaskReach.Type;

/** New tasks the Assistant suggests: proposed for the user to add, or added directly. */
export const AssistantNewTasks = Schema.Literals(["propose", "create"]);
export type AssistantNewTasks = typeof AssistantNewTasks.Type;

/**
 * Answering Status questions on the user's behalf. Only `"never"` exists:
 * silence never authorizes an action, and the Status board's per-decision
 * opt-in already covers "go with the recommendation at the deadline".
 */
export const AssistantAnswerQuestions = Schema.Literals(["never"]);
export type AssistantAnswerQuestions = typeof AssistantAnswerQuestions.Type;

/** Hours between check-ins with the coordinators; 0 is off. Each check-in runs models. */
export const AssistantCheckInHours = Schema.Literals([0, 1, 2, 4]);
export type AssistantCheckInHours = typeof AssistantCheckInHours.Type;

export const AssistantBriefDays = Schema.Literals(["weekdays", "every-day"]);
export type AssistantBriefDays = typeof AssistantBriefDays.Type;

/** `HH:MM`, 24-hour, in the host's time zone. */
export const AssistantBriefTime = Schema.String.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
export type AssistantBriefTime = typeof AssistantBriefTime.Type;

export const AssistantSettings = Schema.Struct({
  /**
   * Project ids the Assistant reads and asks. Null reaches every Project,
   * including ones created later.
   */
  projects: Schema.NullOr(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workspaces: AssistantWorkspaceReach.pipe(Schema.withDecodingDefault(Effect.succeed("read"))),
  tasks: AssistantTaskReach.pipe(Schema.withDecodingDefault(Effect.succeed("edit"))),
  messageCoordinators: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  newTasks: AssistantNewTasks.pipe(Schema.withDecodingDefault(Effect.succeed("propose"))),
  answerQuestions: AssistantAnswerQuestions.pipe(
    Schema.withDecodingDefault(Effect.succeed("never")),
  ),
  /** Off by default: every check-in runs the Assistant and each coordinator it asks. */
  checkInHours: AssistantCheckInHours.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  briefTime: AssistantBriefTime.pipe(Schema.withDecodingDefault(Effect.succeed("07:00"))),
  briefDays: AssistantBriefDays.pipe(Schema.withDecodingDefault(Effect.succeed("weekdays"))),
});
export type AssistantSettings = typeof AssistantSettings.Type;

export const AssistantSettingsPatch = Schema.Struct({
  projects: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  workspaces: Schema.optionalKey(AssistantWorkspaceReach),
  tasks: Schema.optionalKey(AssistantTaskReach),
  messageCoordinators: Schema.optionalKey(Schema.Boolean),
  newTasks: Schema.optionalKey(AssistantNewTasks),
  answerQuestions: Schema.optionalKey(AssistantAnswerQuestions),
  checkInHours: Schema.optionalKey(AssistantCheckInHours),
  briefTime: Schema.optionalKey(AssistantBriefTime),
  briefDays: Schema.optionalKey(AssistantBriefDays),
});
export type AssistantSettingsPatch = typeof AssistantSettingsPatch.Type;

/** Schedule ids the Assistant's settings own on its Project. */
export const ASSISTANT_BRIEF_SCHEDULE_ID = "morning-brief";
export const ASSISTANT_CHECK_IN_SCHEDULE_ID = "check-in";

export const ASSISTANT_BRIEF_PROMPT =
  "Write my morning brief. Call cp_assistant_overview, then reply with a greeting and at most four one-line bullets: what needs me, what shipped or moved, today's tasks and anything overdue, and anything on the calendar. Plain text, no headers.";

export const ASSISTANT_CHECK_IN_PROMPT =
  "Check in: call cp_assistant_overview. Only if something changed that needs me, ask the relevant coordinators with cp_assistant_ask and tell me in one or two lines. Otherwise reply only with 'Nothing new.'";

/** Five-field cron for the brief, read in the host's time zone. */
export function assistantBriefCron(time: AssistantBriefTime, days: AssistantBriefDays): string {
  const [hours, minutes] = time.split(":").map((part) => Number.parseInt(part, 10));
  return `${minutes ?? 0} ${hours ?? 7} * * ${days === "weekdays" ? "1-5" : "*"}`;
}

/** Five-field cron for check-ins, during the working day, or null when off. */
export function assistantCheckInCron(hours: AssistantCheckInHours): string | null {
  if (hours === 0) return null;
  return `0 9-18/${hours} * * 1-5`;
}

/** Whether a Project is in the Assistant's reach. */
export function isProjectInAssistantReach(
  settings: Pick<AssistantSettings, "projects">,
  projectId: string,
): boolean {
  return settings.projects === null || settings.projects.includes(projectId);
}
