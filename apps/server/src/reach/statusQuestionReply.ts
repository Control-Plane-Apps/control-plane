import {
  AssistantNeedsYouError,
  CommandId,
  isStatusNeedingUser,
  MessageId,
  statusAnswerMessageId,
  statusReplyText,
  type AssistantNeedsYouReplyInput,
  type OrchestrationRemoteUserMessageSource,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { isDeliveryIdle } from "../orchestration/agentPushes.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";

/** The same held, version-checked user answer used by notification replies. */
export const makeStatusQuestionReply = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const turns = yield* ProjectionTurnRepository;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  return (input: AssistantNeedsYouReplyInput, source?: OrchestrationRemoteUserMessageSource) =>
    Effect.gen(function* () {
      const self = yield* environment.getEnvironmentId;
      if (input.environmentId !== self) {
        return yield* new AssistantNeedsYouError({
          detail: "The question belongs to another machine.",
        });
      }
      const project = Option.getOrUndefined(
        yield* snapshots
          .getProjectShellById(input.projectId)
          .pipe(
            Effect.mapError(
              () => new AssistantNeedsYouError({ detail: "Could not read the Project." }),
            ),
          ),
      );
      const marker = project?.assistant;
      const status = marker?.statuses?.find((entry) => entry.id === input.statusId);
      const decision = status?.decision;
      if (
        marker == null ||
        marker.archivedAt != null ||
        marker.scope === "global" ||
        marker.coordinatorThreadId !== input.coordinatorThreadId ||
        status === undefined ||
        decision === undefined ||
        decision.openedAt !== input.openedAt ||
        !isStatusNeedingUser(status)
      ) {
        return yield* new AssistantNeedsYouError({
          detail: "This question changed or no longer needs you. Refresh before replying.",
        });
      }
      const thread = Option.getOrUndefined(
        yield* snapshots
          .getThreadShellById(marker.coordinatorThreadId)
          .pipe(
            Effect.mapError(
              () => new AssistantNeedsYouError({ detail: "Could not read the coordinator." }),
            ),
          ),
      );
      if (thread === undefined || thread.archivedAt != null || thread.projectId !== project!.id) {
        return yield* new AssistantNeedsYouError({
          detail: "This Project has no live coordinator.",
        });
      }
      const pending = yield* turns.getPendingTurnStartByThreadId({ threadId: thread.id }).pipe(
        Effect.mapError(
          () =>
            new AssistantNeedsYouError({
              detail: "Could not check the coordinator's pending reply.",
            }),
        ),
      );
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const queued = !isDeliveryIdle(thread.session, Option.getOrNull(pending), createdAt);
      const messageId = statusAnswerMessageId(input.projectId, status.id, decision.openedAt);
      yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(messageId),
          threadId: marker.coordinatorThreadId,
          message: {
            messageId: MessageId.make(messageId),
            text: statusReplyText(status.title, input.text, {
              statusId: status.id,
              openedAt: decision.openedAt,
            }),
            attachments: [],
            ...(source === undefined ? {} : { source }),
          },
          createdAt,
        })
        .pipe(Effect.mapError((error) => new AssistantNeedsYouError({ detail: error.message })));
      return { queued };
    });
});
