/**
 * The issuing side of a machine link: what this server does for a machine
 * that holds one of its link tokens. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module linkTokenIssuer
 */
import {
  AgentMachinesError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AgentMachinePairingInput,
  type AgentMachinePairingResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { buildPairingUrl } from "../startupAccess.ts";
import { linkTokenSubject } from "./linkToken.ts";

type Auth = EnvironmentAuth.EnvironmentAuth["Service"];

/**
 * Revokes every renewed link token this server issued to `holderId`, so
 * unlinking a machine here also ends its access here. A token from the first
 * pairing carries no machine id until its first renewal; until then it is
 * revoked in Settings, Connections, or ends when it expires.
 */
export const revokeIssuedLinkTokens = (auth: Auth, holderId: string): Effect.Effect<number> =>
  auth.listSessions().pipe(
    Effect.flatMap((sessions) =>
      Effect.forEach(
        sessions.filter((session) => session.subject === linkTokenSubject(holderId)),
        (session) => auth.revokeSession(session.sessionId),
      ),
    ),
    Effect.map((revoked) => revoked.filter(Boolean).length),
    Effect.orElseSucceed(() => 0),
  );

/** A one-time link with read and operate scope, for a machine relinking to this one. */
export const mintRelinkPairing = (
  auth: Auth,
  input: AgentMachinePairingInput,
): Effect.Effect<AgentMachinePairingResult, AgentMachinesError> =>
  Effect.gen(function* () {
    const issued = yield* auth
      .createPairingLink({
        ttl: Duration.minutes(10),
        label: `Agent placement from ${input.label}`,
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      })
      .pipe(
        Effect.mapError(
          () => new AgentMachinesError({ detail: "Could not create a pairing link." }),
        ),
      );
    const pairingUrl = yield* Effect.try({
      try: () => buildPairingUrl(input.baseUrl, issued.credential),
      catch: () => new AgentMachinesError({ detail: `'${input.baseUrl}' is not an address.` }),
    });
    return { pairingUrl };
  });
