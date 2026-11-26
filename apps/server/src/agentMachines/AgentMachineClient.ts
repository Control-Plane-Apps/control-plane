/**
 * The home server's HTTP client for a linked machine. It uses only the
 * environment routes every server already serves, with a bearer token limited
 * to `orchestration:read orchestration:operate`. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module AgentMachineClient
 */
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { LINK_RENEW_ROUTE_PATH, LINK_RETIRE_ROUTE_PATH } from "./linkToken.ts";

/** Orchestration protocol this build speaks; a peer that differs is refused. */
export const AGENT_MACHINE_PROTOCOL_VERSION = 1;
export const PEER_REQUEST_TIMEOUT = Duration.seconds(3);
export const AGENT_MACHINE_SCOPE = `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`;

export class PeerError extends Schema.TaggedError<PeerError>()("PeerError", {
  kind: Schema.Literals([
    "invalid-url",
    "unreachable",
    /** Sent, but no answer in time: the peer may still finish it. */
    "timeout",
    "unauthorized",
    "incompatible",
    "wrong-environment",
    "rejected",
  ]),
  detail: Schema.String,
  /** A machine-readable reason the peer gave, such as a link renewal refusal. */
  code: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * The origin to talk to: https, or http to a loopback, private-range or
 * tailnet host. The path, query and fragment (a pairing token) are dropped.
 */
export function validatePeerBaseUrl(raw: string): Effect.Effect<string, PeerError> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return Effect.fail(
      new PeerError({ kind: "invalid-url", detail: "That is not a valid address." }),
    );
  }
  const secure = url.protocol === "https:";
  const privateHttp =
    url.protocol === "http:" &&
    (isLocalLoopbackHost(url.hostname) || isPrivateNetworkHost(url.hostname));
  if (!secure && !privateHttp) {
    return Effect.fail(
      new PeerError({
        kind: "invalid-url",
        detail:
          "Use https, or http to a machine on your tailnet or private network. Plain http over the internet is refused.",
      }),
    );
  }
  return Effect.succeed(url.origin);
}

/** Allowed over the peer client: anything else could delete or rewrite the peer's work. */
export const PEER_COMMAND_ALLOWLIST = [
  "thread.create",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.session.stop",
  "thread.archive",
  "thread.settle",
] as const satisfies ReadonlyArray<ClientOrchestrationCommand["type"]>;

export type PeerCommand = Extract<
  ClientOrchestrationCommand,
  { type: (typeof PEER_COMMAND_ALLOWLIST)[number] }
>;

export const isPeerCommand = (command: ClientOrchestrationCommand): command is PeerCommand =>
  (PEER_COMMAND_ALLOWLIST as ReadonlyArray<string>).includes(command.type);

const noRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const isPeerError = Schema.is(PeerError);

/** Maps any transport or HTTP failure to a `PeerError`. Peer dispatch errors are opaque 500s. */
export function classifyPeerFailure(error: unknown): PeerError {
  if (isPeerError(error)) return error;
  const tag = (error as { readonly _tag?: string } | null)?._tag ?? "";
  const status = (error as { readonly response?: { readonly status?: number } } | null)?.response
    ?.status;
  if (
    tag === "EnvironmentAuthInvalidError" ||
    tag === "EnvironmentHttpUnauthorizedError" ||
    status === 401
  ) {
    return new PeerError({
      kind: "unauthorized",
      detail: "The linked machine rejected the token.",
    });
  }
  if (
    tag === "EnvironmentScopeRequiredError" ||
    tag === "EnvironmentOperationForbiddenError" ||
    tag === "EnvironmentHttpForbiddenError" ||
    status === 403
  ) {
    return new PeerError({
      kind: "unauthorized",
      detail: "The linked machine refused the token's access.",
    });
  }
  if (tag === "TimeoutError") {
    return new PeerError({
      kind: "timeout",
      detail: "The linked machine did not answer in time.",
    });
  }
  if (tag.startsWith("Environment")) {
    return new PeerError({ kind: "rejected", detail: "The linked machine rejected the request." });
  }
  return new PeerError({ kind: "unreachable", detail: "Could not reach the linked machine." });
}

const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout(PEER_REQUEST_TIMEOUT),
    noRedirects,
    Effect.mapError(classifyPeerFailure),
  );

const makeClient = (baseUrl: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl });

/** The peer's own descriptor. Its environment id is checked before any token is sent. */
export const fetchPeerDescriptor = (
  baseUrl: string,
): Effect.Effect<ExecutionEnvironmentDescriptor, PeerError, HttpClient.HttpClient> =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      const descriptor = yield* client.metadata.descriptor();
      const version = descriptor.orchestrationProtocolVersion ?? 1;
      if (version !== AGENT_MACHINE_PROTOCOL_VERSION) {
        return yield* new PeerError({
          kind: "incompatible",
          detail: `The linked machine speaks protocol ${version}; this machine speaks ${AGENT_MACHINE_PROTOCOL_VERSION}. Update the older one.`,
        });
      }
      return descriptor;
    }),
  );

/** Confirms the server at `baseUrl` is still the machine that was linked. */
export const requirePeerIdentity = (baseUrl: string, environmentId: string) =>
  fetchPeerDescriptor(baseUrl).pipe(
    Effect.flatMap((descriptor) =>
      descriptor.environmentId === environmentId
        ? Effect.succeed(descriptor)
        : Effect.fail(
            new PeerError({
              kind: "wrong-environment",
              detail: "A different server answers at this address. Link the machine again.",
            }),
          ),
    ),
  );

/** Trades a pairing credential for a bearer session limited to read and operate. */
export const exchangePairingCredential = (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly clientLabel: string;
}) =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(input.baseUrl);
      const result = yield* client.auth.token({
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: input.credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: AGENT_MACHINE_SCOPE,
          client_label: input.clientLabel,
        },
        headers: {},
      } as Parameters<typeof client.auth.token>[0]);
      if (result.token_type !== "Bearer") {
        return yield* new PeerError({
          kind: "rejected",
          detail: "The linked machine issued a token this machine cannot use.",
        });
      }
      return {
        token: result.access_token,
        expiresInSeconds: result.expires_in,
      };
    }),
  );

export const fetchPeerWorkspace = (
  baseUrl: string,
  token: string,
  projectId: string,
  threadId: string,
) =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.orchestration.agentWorkspace({
        headers: bearer(token),
        params: { projectId: ProjectId.make(projectId), threadId: ThreadId.make(threadId) },
      });
    }),
  );

export const fetchPeerReadiness = (
  baseUrl: string,
  token: string,
  projectId: string,
  instanceId: string,
) =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.orchestration.projectReadiness({
        headers: bearer(token),
        params: { projectId: ProjectId.make(projectId) },
        payload: { instanceId },
      });
    }),
  );

export const fetchPeerShell = (
  baseUrl: string,
  token: string,
): Effect.Effect<OrchestrationShellSnapshot, PeerError, HttpClient.HttpClient> =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.orchestration.shellSnapshot({ headers: bearer(token) });
    }),
  );

/** None when the peer has no such thread. */
export const fetchPeerThread = (
  baseUrl: string,
  token: string,
  threadId: string,
  turnLimit: number,
): Effect.Effect<
  Option.Option<OrchestrationThreadDetailSnapshot>,
  PeerError,
  HttpClient.HttpClient
> =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.orchestration
        .threadSnapshot({
          headers: bearer(token),
          params: { threadId },
          payload: { turnLimit },
        } as Parameters<typeof client.orchestration.threadSnapshot>[0])
        .pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) =>
              (error as { readonly _tag?: string })._tag === "EnvironmentResourceNotFoundError",
            () => Effect.succeed(Option.none<OrchestrationThreadDetailSnapshot>()),
          ),
        );
    }),
  ) as Effect.Effect<
    Option.Option<OrchestrationThreadDetailSnapshot>,
    PeerError,
    HttpClient.HttpClient
  >;

/**
 * Sends one allowlisted command. The peer answers every failure with an opaque
 * 500, so a failure here means "unknown": read the thread to learn what
 * happened, and retry with the same command id.
 */
export const dispatchPeerCommand = (baseUrl: string, token: string, command: PeerCommand) =>
  isPeerCommand(command)
    ? call(
        Effect.gen(function* () {
          const client = yield* makeClient(baseUrl);
          yield* client.orchestration.dispatch({
            headers: bearer(token),
            payload: command,
          } as Parameters<typeof client.orchestration.dispatch>[0]);
        }),
      )
    : Effect.fail(
        new PeerError({
          kind: "rejected",
          detail: `Command ${(command as { type: string }).type} is not allowed on a linked machine.`,
        }),
      );

/** Path of the cross-server reach route every server serves. */
export const REACH_ROUTE_PATH = "/api/reach";
/** A reach op may read several snapshots on the peer, so it gets longer than a probe. */
export const REACH_REQUEST_TIMEOUT = Duration.seconds(8);

/**
 * Posts one reach op. Answers with the peer's JSON body; a 401 or 403 is
 * `unauthorized`, any other non-2xx `rejected`, a transport failure or
 * timeout `unreachable`.
 */
export const postPeerReach = (
  baseUrl: string,
  token: string,
  body: unknown,
  timeout: Duration.Duration = REACH_REQUEST_TIMEOUT,
): Effect.Effect<unknown, PeerError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(new URL(REACH_ROUTE_PATH, baseUrl).toString()).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* client.execute(request);
    if (response.status === 401 || response.status === 403) {
      return yield* new PeerError({
        kind: "unauthorized",
        detail: "The linked machine rejected the token.",
      });
    }
    if (response.status === 404) {
      return yield* new PeerError({
        kind: "incompatible",
        detail: "The linked machine does not serve cross-server reach yet. Update it.",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const reason = text.trim().slice(0, 200);
      return yield* new PeerError({
        kind: "rejected",
        detail: `The linked machine refused the request (${response.status}${reason.length > 0 ? `: ${reason}` : ""}).`,
      });
    }
    return yield* response.json;
  }).pipe(Effect.timeout(timeout), noRedirects, Effect.mapError(classifyPeerFailure));

const RenewedTokenBody = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
});
const decodeRenewedTokenBody = Schema.decodeUnknownOption(RenewedTokenBody);

const postLinkToken = (
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
): Effect.Effect<unknown, PeerError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(new URL(path, baseUrl).toString()).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* client.execute(request);
    if (response.status === 401 || response.status === 403) {
      return yield* new PeerError({
        kind: "unauthorized",
        detail: "The linked machine no longer accepts this link. Link it again.",
      });
    }
    if (response.status === 404) {
      // A build from before renewal: the token works until it expires.
      return yield* new PeerError({
        kind: "incompatible",
        detail: "The linked machine runs an older version that cannot renew links. Update it.",
      });
    }
    if (response.status === 409) {
      const refusal = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      const code =
        typeof refusal === "object" && refusal !== null && "error" in refusal
          ? String((refusal as { readonly error: unknown }).error)
          : "unknown";
      return yield* new PeerError({
        kind: "rejected",
        code,
        detail: `The linked machine refused to renew the link (${code}).`,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new PeerError({
        kind: "rejected",
        detail: `The linked machine refused to renew the link (${response.status}).`,
      });
    }
    return yield* response.json;
  }).pipe(
    Effect.timeout(LINK_TOKEN_REQUEST_TIMEOUT),
    noRedirects,
    Effect.mapError(classifyPeerFailure),
  );

/**
 * The issuer cuts the old token to a short grace as it answers, so a lost
 * answer costs the link: allow more than a probe.
 */
export const LINK_TOKEN_REQUEST_TIMEOUT = Duration.seconds(10);

/** Trades a still-valid link token for a fresh one; the old one keeps working until retired. */
export const renewPeerToken = (input: {
  readonly baseUrl: string;
  readonly token: string;
  /** This machine's id, so the peer can revoke the new token when it unlinks this machine. */
  readonly environmentId: string;
  /** Random per renewal and reused on retries, so a retry after a lost answer gets the same token. */
  readonly requestId: string;
}): Effect.Effect<
  { readonly token: string; readonly expiresInSeconds: number },
  PeerError,
  HttpClient.HttpClient
> =>
  postLinkToken(input.baseUrl, LINK_RENEW_ROUTE_PATH, input.token, {
    environmentId: input.environmentId,
    requestId: input.requestId,
  }).pipe(
    Effect.flatMap((body) => {
      const decoded = decodeRenewedTokenBody(body);
      if (
        Option.isNone(decoded) ||
        decoded.value.token_type !== "Bearer" ||
        decoded.value.access_token.length === 0
      ) {
        return Effect.fail(
          new PeerError({
            kind: "rejected",
            detail: "The linked machine issued a token this machine cannot use.",
          }),
        );
      }
      return Effect.succeed({
        token: decoded.value.access_token,
        expiresInSeconds: decoded.value.expires_in,
      });
    }),
  );

/** Revokes `token` on the peer. Used for the old token after renewal and when unlinking. */
export const retirePeerToken = (
  baseUrl: string,
  token: string,
): Effect.Effect<void, PeerError, HttpClient.HttpClient> =>
  postLinkToken(baseUrl, LINK_RETIRE_ROUTE_PATH, token, {}).pipe(Effect.asVoid);
