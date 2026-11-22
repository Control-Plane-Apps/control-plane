import { describe, expect, it } from "@effect/vitest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { bearerOnly } from "./route.ts";
import { reachBodyLimit } from "./reachProtocol.ts";

const request = (headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3773/api/reach", { method: "POST", headers }),
  );

describe("reach route", () => {
  it("refuses a request that carries only the browser session cookie", () => {
    expect(bearerOnly(request({ cookie: "t3_session=abc" }))).toBeNull();
  });

  it("authenticates by the bearer token alone, with cookies dropped", () => {
    const stripped = bearerOnly(
      request({ cookie: "t3_session=abc", authorization: "Bearer token-1" }),
    );
    expect(stripped?.cookies).toEqual({});
    expect(stripped?.headers.authorization).toBe("Bearer token-1");
  });

  it("keeps ordinary ops small", () => {
    expect(reachBodyLimit("thread.send")).toBe(256 * 1024);
  });
});
