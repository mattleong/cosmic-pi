import { describe, expect, it } from "@effect/vitest";
import {
  MissingRequiredClientCapabilityError,
  UnsupportedProtocolVersionError,
  UrlElicitationRequiredError,
  serializeMessage,
  type FetchLike,
} from "@modelcontextprotocol/client";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerResponse } from "effect/unstable/http";
import { yieldUntil } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { openSdkHttp } from "../../src/boundary/sdk-http.ts";
import { getAuthChallenge } from "../../src/auth/challenge.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";
import {
  beginSdkHttpChallenge,
  captureSdkHttpChallenge,
} from "../../src/boundary/sdk-http-challenge.ts";
import { SdkHttpOperationRegistry, mapSdkFailure } from "../../src/boundary/sdk-http-transport.ts";
import * as SdkClient from "../../src/boundary/sdk-client.ts";
import { startHttpServer, type HttpRequestRecord } from "../fixtures/http-server.ts";
import { protocolErrors } from "../fixtures/sdk-protocol-errors.ts";

const Wire = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    id: Schema.optionalKey(Schema.Finite),
    params: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  }),
);
const decodeWire = Schema.decodeUnknownOption(Wire);
const parseMessage = (body: BodyInit | null | undefined) => Option.getOrUndefined(decodeWire(body));
type WireMessage = NonNullable<ReturnType<typeof parseMessage>>;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const bytes = (value: string) => new TextEncoder().encode(value);
const resultBody = (id: number | undefined, result: typeof Schema.Json.Type) => {
  if (id === undefined) throw new Error("Fixture response needs a request ID.");
  return json({ jsonrpc: "2.0", id, result });
};
const initialized = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  serverInfo: { name: "fixture", version: "1" },
};
const toolResult = { content: [{ type: "text", text: "ok" }] };
const defaults = {
  protocol: "legacy" as const,
  connectTimeoutMs: 1_000,
  requestTimeoutMs: 1_000,
  cleanupTimeoutMs: 1_000,
};
const fakeUrl = new URL("https://example.test/mcp");

const defaultResponse = (method: string | undefined, message: WireMessage | undefined) => {
  if (method === "GET") return new Response(null, { status: 405 });
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (message?.id === undefined) return new Response(null, { status: 202 });
  const headers = new Headers({ "content-type": "application/json" });
  if (message.method === "initialize") headers.set("mcp-session-id", "fixture-session");
  return new Response(
    resultBody(message.id, message.method === "initialize" ? initialized : toolResult),
    { headers },
  );
};

// The owned FetchLike seam lets tests stop exactly at headers, reads, and cancellation.
const controlledFetch =
  (
    custom: (
      init: RequestInit | undefined,
      message: WireMessage | undefined,
    ) => Promise<Response> | undefined,
  ): FetchLike =>
  (_url, init) =>
    custom(init, parseMessage(init?.body)) ??
    Promise.resolve(defaultResponse(init?.method, parseMessage(init?.body)));

const realFixture = (
  custom: (
    request: HttpRequestRecord,
    message: WireMessage | undefined,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse> | undefined = () => undefined,
) =>
  startHttpServer((request) => {
    const message = parseMessage(request.body);
    return (
      custom(request, message) ??
      Effect.succeed(HttpServerResponse.fromWeb(defaultResponse(request.method, message)))
    );
  });

const unsupportedErrors = [
  {
    name: "URL elicitation",
    error: new UrlElicitationRequiredError(
      [
        {
          mode: "url",
          url: "https://private-url.test",
          elicitationId: "private-id",
          message: "private-prompt",
        },
      ],
      "private-server-message",
    ),
  },
  {
    name: "required client capability",
    error: new MissingRequiredClientCapabilityError(
      { requiredCapabilities: { experimental: { "private-capability": {} } } },
      "private-server-message",
    ),
  },
  {
    name: "protocol version",
    error: new UnsupportedProtocolVersionError(
      { requested: "private-version", supported: ["private-supported"] },
      "private-server-message",
    ),
  },
];
const protocolResponses = [
  ...unsupportedErrors.map((entry) => ({ ...entry, kind: "unsupported", reason: undefined })),
  ...protocolErrors,
].map(({ name, error, kind, reason }) => ({
  name,
  kind,
  reason,
  response: { error: { code: error.code, message: error.message, data: error.data } },
}));

afterEach(() => vi.restoreAllMocks());

describe("scoped SDK HTTP connection", () => {
  it.live.each([600_001, 3_600_000])(
    "accepts a %i ms request timeout for an immediately completed HTTP call",
    (requestTimeoutMs) =>
      Effect.gen(function* () {
        const fixture = yield* realFixture();
        const connection = yield* openSdkHttp({ url: fixture.url, ...defaults, requestTimeoutMs });
        expect((yield* connection.request({ action: "tools.call", tool: "example" })).outcome).toBe(
          "completed",
        );
      }),
  );

  it.effect.each(protocolResponses)(
    "classifies and redacts $name without replay",
    ({ response, kind, reason }) =>
      Effect.gen(function* () {
        let calls = 0;
        const cleanup: boolean[] = [];
        const connection = yield* openSdkHttp({
          url: fakeUrl,
          ...defaults,
          onCleanup: (confirmed) => cleanup.push(confirmed),
          fetch: controlledFetch((_init, message) => {
            if (message?.method !== "tools/list" || message.id === undefined) return undefined;
            calls += 1;
            return Promise.resolve(
              new Response(serializeMessage({ jsonrpc: "2.0", id: message.id, ...response }), {
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        });
        expect(connection.protocolVersion).toBe(initialized.protocolVersion);
        const result = yield* connection.request({ action: "tools.list" }).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { kind, outcome: "completed" },
        });
        if (result._tag === "Failure") expect(result.failure.reason).toBe(reason);
        expect(String(result)).not.toContain("private-");
        expect(calls).toBe(1);
        expect(yield* connection.health).toMatchObject({
          closed: false,
          cleanupUnconfirmed: false,
        });
        yield* connection.close;
        expect(cleanup).toEqual([true]);
      }),
  );
  it.effect.each(protocolResponses)(
    "cleans up initialization rejected for $name",
    ({ response, kind, reason }) =>
      Effect.gen(function* () {
        let calls = 0;
        const cleanup: boolean[] = [];
        const result = yield* openSdkHttp({
          url: fakeUrl,
          ...defaults,
          onCleanup: (confirmed) => cleanup.push(confirmed),
          fetch: controlledFetch((_init, message) => {
            if (message?.method !== "initialize" || message.id === undefined) return undefined;
            calls += 1;
            return Promise.resolve(
              new Response(serializeMessage({ jsonrpc: "2.0", id: message.id, ...response }), {
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        }).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { kind, outcome: "completed" },
        });
        if (result._tag === "Failure") expect(result.failure.reason).toBe(reason);
        expect(String(result)).not.toContain("private-");
        expect(calls).toBe(1);
        expect(cleanup).toEqual([true]);
      }),
  );

  it.effect("headless input-required remains incomplete and never exposes private state", () =>
    Effect.gen(function* () {
      const connection = yield* openSdkHttp({
        url: fakeUrl,
        ...defaults,
        fetch: controlledFetch(() => undefined),
      });
      // The legacy decoder strips modern discriminators. This owned seam covers only
      // the defensive guard on accepted SDK results, not a modern negotiation mode.
      const inputRequired = {
        content: [],
        resultType: "input_required",
        requestState: "private-input-state",
      };
      vi.spyOn(SdkClient, "executeSdkRequest").mockResolvedValue(inputRequired);
      const result = yield* connection
        .request({ action: "tools.call", tool: "unsupported" })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "unsupported", outcome: "unknown" },
      });
      expect(String(result)).not.toContain("private-");
    }),
  );

  it.live("dispatches with fixed token auth and strips private operation tags", () =>
    Effect.gen(function* () {
      const fixture = yield* realFixture();
      const reply = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* openSdkHttp({
            url: fixture.url,
            ...defaults,
            headers: { Authorization: "Bearer stale", "X-PI-MCP-OPERATION": "private" },
            token: "snapshot-token",
          });
          expect(connection.protocolVersion).toBe(initialized.protocolVersion);
          return yield* connection.request({ action: "tools.call", tool: "example" });
        }),
      );
      expect(reply).toEqual({ action: "tools.call", outcome: "completed", result: toolResult });
      for (const request of fixture.requests) {
        expect(request.headers["x-pi-mcp-operation"]).toBeUndefined();
        expect(request.headers.authorization).toBe("Bearer snapshot-token");
      }
      expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    }),
  );

  it.live("returns an SSE result before EOF and confirms source cancellation", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const fixture = yield* realFixture((_request, message) => {
        if (message?.method !== "tools/call") return undefined;
        return Effect.succeed(
          HttpServerResponse.stream(
            Stream.make(
              bytes(`event: message\ndata: ${resultBody(message.id, toolResult)}\n\n`),
            ).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(Deferred.succeed(cancelled, undefined)),
            ),
            { contentType: "text/event-stream" },
          ),
        );
      });
      const connection = yield* openSdkHttp({ url: fixture.url, ...defaults });
      const reply = yield* connection.request({ action: "tools.call", tool: "sse" });
      yield* Deferred.await(cancelled);
      expect(reply.outcome).toBe("completed");
      // Cancellation was confirmed while the connection and test scopes remain open.
      expect((yield* connection.request({ action: "tools.call", tool: "sse" })).outcome).toBe(
        "completed",
      );
    }),
  );

  it.live("external interruption cancels the actual HTTP request without harming siblings", () =>
    Effect.gen(function* () {
      const slowSeen = yield* Deferred.make<void>();
      const slowCancelled = yield* Deferred.make<void>();
      const fixture = yield* realFixture((request, message) => {
        if (message?.method !== "tools/call" || !request.body.includes('"slow"')) return undefined;
        return Deferred.succeed(slowSeen, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(slowCancelled, undefined)),
        );
      });
      const connection = yield* openSdkHttp({ url: fixture.url, ...defaults });
      const slow = yield* Effect.forkChild(
        connection.request({ action: "tools.call", tool: "slow" }),
      );
      yield* Deferred.await(slowSeen);
      yield* Fiber.interrupt(slow);
      yield* Deferred.await(slowCancelled);
      expect((yield* connection.request({ action: "tools.call", tool: "fast" })).result).toEqual(
        toolResult,
      );
    }),
  );

  for (const status of [401, 403]) {
    it.live(`does not replay a dispatched HTTP ${status} request`, () =>
      Effect.gen(function* () {
        let calls = 0;
        const fixture = yield* realFixture((_request, message) => {
          if (message?.method !== "tools/call") return undefined;
          calls += 1;
          return Effect.succeed(HttpServerResponse.empty({ status }));
        });
        const connection = yield* openSdkHttp({
          url: fixture.url,
          token: "fixed-token",
          ...defaults,
        });
        const result = yield* Effect.result(
          connection.request({ action: "tools.call", tool: "denied" }),
        );
        expect(Result.isFailure(result) && result.failure).toMatchObject({
          kind: status === 401 ? "auth-required" : "denied",
          outcome: "unknown",
        });
        expect(calls).toBe(1);
      }),
    );
  }

  it.effect("keeps interleaved POST challenges private and bound to their own failures", () =>
    Effect.gen(function* () {
      const challenges = {
        first: 'Bearer resource_metadata="https://private.example/first?secret=PRIVATE_FIRST"',
        second: 'Bearer error="insufficient_scope", scope="PRIVATE_SECOND"',
      };
      const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
      const calls: string[] = [];
      const connection = yield* openSdkHttp({
        url: fakeUrl,
        ...defaults,
        token: "PRIVATE_TOKEN",
        fetch: controlledFetch((_init, message) => {
          if (message?.method !== "tools/call") return undefined;
          const name = message.params?.name === "first" ? "first" : "second";
          calls.push(name);
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  bodies.set(name, controller);
                },
              }),
              {
                status: name === "first" ? 401 : 403,
                headers: { "www-authenticate": challenges[name] },
              },
            ),
          );
        }),
      });
      const first = yield* Effect.forkChild(
        connection.request({ action: "tools.call", tool: "first" }).pipe(Effect.flip),
      );
      const second = yield* Effect.forkChild(
        connection.request({ action: "tools.call", tool: "second" }).pipe(Effect.flip),
      );
      yield* yieldUntil(() => bodies.size === 2);
      bodies.get("second")!.close();
      const secondError = yield* Fiber.join(second);
      bodies.get("first")!.close();
      const firstError = yield* Fiber.join(first);
      expect(firstError).toMatchObject({ kind: "auth-required", outcome: "unknown" });
      expect(secondError).toMatchObject({
        kind: "auth-required",
        outcome: "unknown",
        reason: "oauth-insufficient-scope",
      });
      expect(getAuthChallenge(firstError)).toEqual({
        status: 401,
        wwwAuthenticate: challenges.first,
      });
      expect(getAuthChallenge(secondError)).toEqual({
        status: 403,
        wwwAuthenticate: challenges.second,
      });
      expect(calls.sort()).toEqual(["first", "second"]);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
          firstError,
          secondError,
          mcpFailureReply("tools.call", secondError),
        ]),
      ).not.toMatch(/PRIVATE_|private\.example|wwwAuthenticate/);
    }),
  );

  it.effect.each([
    { name: "valid", challenge: 'Bearer resource_metadata="https://private.example/metadata"' },
    { name: "malformed", challenge: 'Bearer resource_metadata="not a URL PRIVATE_MALFORMED"' },
    { name: "oversized", challenge: `Bearer scope="${"X".repeat(9_000)}"` },
  ])("preserves $name initialization challenge evidence before SDK parsing", ({ challenge }) =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* openSdkHttp({
        url: fakeUrl,
        ...defaults,
        fetch: controlledFetch((_init, message) => {
          if (message?.method !== "initialize") return undefined;
          calls += 1;
          return Promise.resolve(
            new Response(null, { status: 401, headers: { "www-authenticate": challenge } }),
          );
        }),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ kind: "auth-required", outcome: "unknown" });
      expect(getAuthChallenge(error)).toEqual({
        status: 401,
        wwwAuthenticate: challenge.slice(0, 8_193),
      });
      expect(calls).toBe(1);
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error)).not.toMatch(
        /PRIVATE_|private\.example|wwwAuthenticate/,
      );
    }),
  );

  it.effect("does not inherit challenge headers from success or unrelated session traffic", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const connection = yield* openSdkHttp({
        url: fakeUrl,
        ...defaults,
        fetch: controlledFetch((init, message) => {
          if (init?.method === "GET")
            return Promise.resolve(
              new Response(null, {
                status: 405,
                headers: { "www-authenticate": 'Bearer scope="PRIVATE_GET"' },
              }),
            );
          if (message?.method !== "tools/call") return undefined;
          const name = message.params?.name ?? "";
          calls.push(name);
          if (name === "success") {
            const response = defaultResponse(init?.method, message);
            response.headers.set("www-authenticate", 'Bearer scope="PRIVATE_SUCCESS"');
            return Promise.resolve(response);
          }
          return Promise.resolve(new Response(null, { status: name === "bare403" ? 403 : 401 }));
        }),
      });
      expect((yield* connection.request({ action: "tools.call", tool: "success" })).outcome).toBe(
        "completed",
      );
      for (const name of ["bare401", "bare403"]) {
        const error = yield* connection
          .request({ action: "tools.call", tool: name })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          kind: name === "bare401" ? "auth-required" : "denied",
          outcome: "unknown",
        });
        expect(getAuthChallenge(error)).toBeUndefined();
      }
      expect(calls).toEqual(["success", "bare401", "bare403"]);
    }),
  );

  it("refuses stale, reused, and cross-operation SDK error associations", () => {
    const registry = new SdkHttpOperationRegistry(1);
    const first = registry.begin()!;
    const second = registry.begin()!;
    const challenge = 'Bearer resource_metadata="https://private.example/metadata"';
    const capture = (operation: typeof first, error: Error) => {
      const settle = beginSdkHttpChallenge(operation);
      captureSdkHttpChallenge(
        operation,
        new Response(null, { status: 401, headers: { "www-authenticate": challenge } }),
      );
      settle(error);
    };
    const firstError = new TypeError("PRIVATE SDK parser error");
    capture(first, firstError);
    expect(getAuthChallenge(mapSdkFailure(firstError, first))).toBeDefined();
    expect(getAuthChallenge(mapSdkFailure(firstError, second))).toBeUndefined();
    capture(second, firstError);
    expect(getAuthChallenge(mapSdkFailure(firstError, first))).toBeUndefined();
    expect(getAuthChallenge(mapSdkFailure(firstError, second))).toBeUndefined();
    const lateError = new TypeError("late");
    capture(first, lateError);
    first.abort();
    expect(getAuthChallenge(mapSdkFailure(lateError, first))).toBeUndefined();
    const start = beginSdkHttpChallenge(second);
    const overlap = beginSdkHttpChallenge(second);
    captureSdkHttpChallenge(
      second,
      new Response(null, { status: 401, headers: { "www-authenticate": challenge } }),
    );
    const ambiguous = new TypeError("overlapping sends");
    start(ambiguous);
    overlap(ambiguous);
    expect(getAuthChallenge(mapSdkFailure(ambiguous, second))).toBeUndefined();
  });

  it.live("never replays an expired-session call, even after explicit replacement", () =>
    Effect.gen(function* () {
      const initializations: Array<string | undefined> = [];
      const sideEffects: Array<{ tool: string | undefined; session: string | undefined }> = [];
      const cleanup: boolean[] = [];
      const fixture = yield* realFixture((request, message) => {
        if (message?.method === "initialize") {
          initializations.push(request.headers["mcp-session-id"]);
          return Effect.succeed(
            HttpServerResponse.fromWeb(
              new Response(resultBody(message.id, initialized), {
                headers: {
                  "content-type": "application/json",
                  "mcp-session-id": initializations.length === 1 ? "sessionA" : "sessionB",
                },
              }),
            ),
          );
        }
        if (message?.method !== "tools/call") return undefined;
        // A failed HTTP response cannot prove that the server did no work.
        sideEffects.push({
          tool: message.params?.name,
          session: request.headers["mcp-session-id"],
        });
        return message.params?.name === "expired"
          ? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          : undefined;
      });
      const connection = yield* openSdkHttp({
        url: fixture.url,
        ...defaults,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      });
      expect(
        yield* connection.request({ action: "tools.call", tool: "expired" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { kind: "transport", outcome: "unknown" },
      });
      expect(sideEffects).toEqual([{ tool: "expired", session: "sessionA" }]);
      expect(initializations).toEqual([undefined]);
      expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);

      yield* connection.close;
      expect(cleanup).toEqual([true]);
      expect(yield* connection.health).toMatchObject({ closed: true, cleanupUnconfirmed: false });
      expect(
        fixture.requests
          .filter((request) => request.method === "DELETE")
          .map((request) => request.headers["mcp-session-id"]),
      ).toEqual(["sessionA"]);
      const closedRequestCount = fixture.requests.length;
      expect(
        yield* connection.request({ action: "tools.call", tool: "expired" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { kind: "unavailable", outcome: "not-sent" },
      });
      expect(fixture.requests).toHaveLength(closedRequestCount);

      const replacement = yield* openSdkHttp({ url: fixture.url, ...defaults });
      expect(initializations).toEqual([undefined, undefined]);
      expect(sideEffects).toEqual([{ tool: "expired", session: "sessionA" }]);
      expect(yield* replacement.request({ action: "tools.call", tool: "separate" })).toMatchObject({
        outcome: "completed",
        result: toolResult,
      });
      expect(sideEffects).toEqual([
        { tool: "expired", session: "sessionA" },
        { tool: "separate", session: "sessionB" },
      ]);
      yield* replacement.close;
      expect(initializations).toHaveLength(2);
      expect(sideEffects).toHaveLength(2);
    }),
  );

  it.effect("redacts initialization HTTP 404 without recovery or session deletion", () =>
    Effect.gen(function* () {
      const requests: Array<{
        method: string | undefined;
        rpc: string | undefined;
        session: string | null;
      }> = [];
      const cleanup: boolean[] = [];
      const result = yield* openSdkHttp({
        url: fakeUrl,
        ...defaults,
        onCleanup: (confirmed) => cleanup.push(confirmed),
        fetch: controlledFetch((init, message) => {
          requests.push({
            method: init?.method,
            rpc: message?.method,
            session: new Headers(init?.headers).get("mcp-session-id"),
          });
          return message?.method === "initialize"
            ? Promise.resolve(new Response("private-expired-session-response", { status: 404 }))
            : undefined;
        }),
      }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "transport", outcome: "unknown" },
      });
      expect(String(result)).not.toContain("private-");
      expect(cleanup).toEqual([true]);
      // Failed initialization never starts application traffic, recovery, or DELETE.
      expect(requests).toEqual([{ method: "POST", rpc: "initialize", session: null }]);
    }),
  );

  it.live("confirms native cleanup despite DELETE 404 after an expired-session call", () =>
    Effect.gen(function* () {
      const cleanup: boolean[] = [];
      const fixture = yield* realFixture((request, message) =>
        request.method === "DELETE" || message?.method === "tools/call"
          ? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          : undefined,
      );
      const connection = yield* openSdkHttp({
        url: fixture.url,
        ...defaults,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      });
      expect(
        yield* connection.request({ action: "tools.call", tool: "expired" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { kind: "transport", outcome: "unknown" },
      });
      const closed = yield* connection.close.pipe(Effect.result);
      expect(closed._tag).toBe("Success");
      expect(yield* connection.health).toMatchObject({ closed: true, cleanupUnconfirmed: false });
      expect(cleanup).toEqual([true]);
      expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
      expect(
        fixture.requests.filter((request) => parseMessage(request.body)?.method === "initialize"),
      ).toHaveLength(1);
      const calls = fixture.requests.filter(
        (request) => parseMessage(request.body)?.method === "tools/call",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers["mcp-session-id"]).toBe("fixture-session");
      const closedRequestCount = fixture.requests.length;
      expect(yield* connection.close.pipe(Effect.result)).toEqual(closed);
      expect(
        yield* connection.request({ action: "tools.call", tool: "later" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { kind: "unavailable", outcome: "not-sent" },
      });
      expect(fixture.requests).toHaveLength(closedRequestCount);
      expect(cleanup).toEqual([true]);
    }),
  );

  it.live("maps declared byte overflow while aborting an actual HTTP response", () =>
    Effect.gen(function* () {
      const fixture = yield* realFixture((_request, message) => {
        if (message?.method !== "tools/call") return undefined;
        return Effect.succeed(
          HttpServerResponse.text("x".repeat(1024), {
            contentType: "application/json",
          }),
        );
      });
      const connection = yield* openSdkHttp({ url: fixture.url, ...defaults, responseBytes: 512 });
      const result = yield* Effect.result(
        connection.request({ action: "tools.call", tool: "oversized" }),
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({ kind: "output-limit" });
    }),
  );

  for (const status of [200, 400, 401, 403]) {
    it.effect(
      `preserves a streamed output-limit failure at HTTP ${status} without poisoning a sibling`,
      () =>
        Effect.gen(function* () {
          const siblingHeaders = yield* Deferred.make<Response>();
          const siblingSeen = yield* Deferred.make<void>();
          let siblingId: number | undefined;
          let badCalls = 0;
          const fetch = controlledFetch((_init, message) => {
            if (message?.method !== "tools/call") return undefined;
            if (message.params?.name === "sibling") {
              siblingId = message.id;
              Deferred.doneUnsafe(siblingSeen, Effect.void);
              return Effect.runPromise(Deferred.await(siblingHeaders));
            }
            if (message.params?.name !== "bad") return undefined;
            badCalls += 1;
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytes("x".repeat(1024)));
                  },
                }),
                { status, headers: { "content-type": "text/event-stream" } },
              ),
            );
          });
          const connection = yield* openSdkHttp({
            url: fakeUrl,
            fetch,
            responseBytes: 512,
            ...defaults,
          });
          const sibling = yield* Effect.forkChild(
            connection.request({ action: "tools.call", tool: "sibling" }),
          );
          yield* Deferred.await(siblingSeen);
          const bad = yield* Effect.result(
            connection.request({ action: "tools.call", tool: "bad" }),
          );
          expect(Result.isFailure(bad) && bad.failure).toMatchObject({
            kind: "output-limit",
            outcome: "unknown",
          });
          expect(badCalls).toBe(1);
          yield* Deferred.succeed(
            siblingHeaders,
            new Response(resultBody(siblingId, toolResult), {
              headers: { "content-type": "application/json" },
            }),
          );
          expect((yield* Fiber.join(sibling)).outcome).toBe("completed");
          expect((yield* connection.request({ action: "tools.call", tool: "later" })).outcome).toBe(
            "completed",
          );
        }),
    );
  }

  it.effect("an interrupted first close still finishes session traffic and caches success", () =>
    Effect.gen(function* () {
      const getSeen = yield* Deferred.make<void>();
      const deleteSeen = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<Response>();
      let deletes = 0;
      let getCancelled = false;
      const fetch = controlledFetch((init) => {
        if (init?.method === "GET") {
          Deferred.doneUnsafe(getSeen, Effect.void);
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  getCancelled = true;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        }
        if (init?.method !== "DELETE") return undefined;
        deletes += 1;
        Deferred.doneUnsafe(deleteSeen, Effect.void);
        return Effect.runPromise(Deferred.await(releaseDelete));
      });
      const connection = yield* openSdkHttp({ url: fakeUrl, fetch, ...defaults });
      yield* Deferred.await(getSeen);
      const closing = yield* Effect.forkChild(connection.close);
      yield* Deferred.await(deleteSeen);
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(closing));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseDelete, new Response(null, { status: 204 }));
      yield* Fiber.join(interrupt);
      yield* connection.close;
      expect(getCancelled).toBe(true);
      expect(deletes).toBe(1);
      const later = yield* Effect.result(
        connection.request({ action: "tools.call", tool: "late" }),
      );
      expect(Result.isFailure(later) && later.failure).toMatchObject({
        kind: "unavailable",
        outcome: "not-sent",
      });
    }),
  );

  it.effect(
    "close deadlines remain interruptible and unconfirmed late DELETE is never replayed",
    () =>
      Effect.gen(function* () {
        const deleteSeen = yield* Deferred.make<void>();
        const deleteHeaders = yield* Deferred.make<Response>();
        let deletes = 0;
        let deleteAborted = false;
        let lateBodyCancelled = false;
        const fetch = controlledFetch((init) => {
          if (init?.method !== "DELETE") return undefined;
          deletes += 1;
          init.signal?.addEventListener(
            "abort",
            () => {
              deleteAborted = true;
            },
            { once: true },
          );
          Deferred.doneUnsafe(deleteSeen, Effect.void);
          return Effect.runPromise(Deferred.await(deleteHeaders));
        });
        const connection = yield* openSdkHttp({
          url: fakeUrl,
          fetch,
          ...defaults,
          cleanupTimeoutMs: 20,
        });
        const closing = yield* Effect.forkChild(Effect.result(connection.close));
        yield* Deferred.await(deleteSeen);
        yield* TestClock.adjust(Duration.millis(20));
        yield* yieldUntil(() => deleteAborted);
        yield* TestClock.adjust(Duration.millis(20));
        const result = yield* Fiber.join(closing);
        expect(Result.isFailure(result) && result.failure).toMatchObject({ kind: "cleanup" });
        yield* Deferred.succeed(
          deleteHeaders,
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                lateBodyCancelled = true;
              },
            }),
          ),
        );
        yield* yieldUntil(() => lateBodyCancelled);
        const repeated = yield* Effect.result(connection.close);
        expect(repeated).toEqual(result);
        expect(deletes).toBe(1);
      }),
  );

  it.effect("an interrupted stalled close caches cleanup failure rather than interruption", () =>
    Effect.gen(function* () {
      const deleteSeen = yield* Deferred.make<void>();
      let aborted = false;
      let deletes = 0;
      const fetch = controlledFetch((init) => {
        if (init?.method !== "DELETE") return undefined;
        deletes += 1;
        init.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        Deferred.doneUnsafe(deleteSeen, Effect.void);
        return Effect.runPromise(Effect.never, { signal: init.signal ?? undefined });
      });
      const connection = yield* openSdkHttp({
        url: fakeUrl,
        fetch,
        ...defaults,
        cleanupTimeoutMs: 20,
      });
      const closing = yield* Effect.forkChild(connection.close);
      yield* Deferred.await(deleteSeen);
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(closing));
      yield* TestClock.adjust(Duration.millis(20));
      yield* Fiber.join(interrupt);
      const repeated = yield* Effect.result(connection.close);
      expect(Result.isFailure(repeated) && repeated.failure).toMatchObject({ kind: "cleanup" });
      expect(aborted).toBe(true);
      expect(deletes).toBe(1);
    }),
  );

  it.effect(
    "holds interrupted request ownership through its cleanup budget and closes admission",
    () =>
      Effect.gen(function* () {
        const cancelSeen = yield* Deferred.make<void>();
        const releaseCancel = yield* Deferred.make<void>();
        const callSeen = yield* Deferred.make<void>();
        const fetch = controlledFetch((_init, message) => {
          if (message?.method !== "tools/call") return undefined;
          Deferred.doneUnsafe(callSeen, Effect.void);
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  Deferred.doneUnsafe(cancelSeen, Effect.void);
                  return Effect.runPromise(Deferred.await(releaseCancel));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        });
        const connection = yield* openSdkHttp({
          url: fakeUrl,
          fetch,
          ...defaults,
          cleanupTimeoutMs: 20,
        });
        const running = yield* Effect.forkChild(
          connection.request({ action: "tools.call", tool: "slow" }),
        );
        yield* Deferred.await(callSeen);
        const interruptionDone = yield* Deferred.make<void>();
        const interruption = yield* Effect.forkChild(
          Fiber.interrupt(running).pipe(
            Effect.andThen(Deferred.succeed(interruptionDone, undefined)),
          ),
        );
        yield* Deferred.await(cancelSeen);
        expect(yield* Deferred.isDone(interruptionDone)).toBe(false);
        yield* TestClock.adjust(Duration.millis(20));
        yield* Fiber.join(interruption);
        const later = yield* Effect.result(
          connection.request({ action: "tools.call", tool: "late" }),
        );
        expect(Result.isFailure(later) && later.failure).toMatchObject({ kind: "unavailable" });
        yield* Deferred.succeed(releaseCancel, undefined);
        yield* connection.close;
      }),
  );

  it.effect(
    "repeated call timeouts clean cancellation POSTs without closing GET or sibling calls",
    () =>
      Effect.gen(function* () {
        let slowCalls = 0;
        let liveControls = 0;
        let controlsSeen = 0;
        let getCancelled = false;
        let siblingAborted = false;
        let siblingId: number | undefined;
        let releaseSibling: ((response: Response) => void) | undefined;
        const fetch = controlledFetch((init, message) => {
          if (init?.method === "GET") {
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  cancel() {
                    getCancelled = true;
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
            );
          }
          if (message?.method === "notifications/cancelled") {
            controlsSeen += 1;
            liveControls += 1;
            init?.signal?.addEventListener(
              "abort",
              () => {
                liveControls -= 1;
              },
              { once: true },
            );
            return Effect.runPromise(Effect.never, { signal: init?.signal ?? undefined });
          }
          if (message?.method !== "tools/call") return undefined;
          if (message.params?.name === "slow") {
            slowCalls += 1;
            return Effect.runPromise(Effect.never, { signal: init?.signal ?? undefined });
          }
          if (message.params?.name !== "sibling") return undefined;
          siblingId = message.id;
          init?.signal?.addEventListener(
            "abort",
            () => {
              siblingAborted = true;
            },
            { once: true },
          );
          return Effect.runPromise(
            Effect.callback<Response>((resume) => {
              releaseSibling = (response) => resume(Effect.succeed(response));
            }),
          );
        });
        const connection = yield* openSdkHttp({
          url: fakeUrl,
          fetch,
          ...defaults,
          requestTimeoutMs: 20,
          cleanupTimeoutMs: 10,
        });
        for (let index = 0; index < 3; index += 1) {
          const call = yield* Effect.forkChild(
            Effect.result(connection.request({ action: "tools.call", tool: "slow" })),
          );
          yield* yieldUntil(() => slowCalls === index + 1);
          yield* TestClock.adjust(Duration.millis(20));
          const result = yield* Fiber.join(call);
          expect(Result.isFailure(result) && result.failure).toMatchObject({ kind: "timeout" });
          yield* yieldUntil(() => controlsSeen === index + 1);
          expect(liveControls).toBe(1);
          yield* TestClock.adjust(Duration.millis(10));
          siblingAborted = false;
          releaseSibling = undefined;
          const sibling = yield* Effect.forkChild(
            connection.request({ action: "tools.call", tool: "sibling" }),
          );
          yield* yieldUntil(() => releaseSibling !== undefined);
          yield* TestClock.adjust(Duration.millis(10));
          yield* yieldUntil(() => liveControls === 0);
          expect(getCancelled).toBe(false);
          expect(siblingAborted).toBe(false);
          releaseSibling!(
            new Response(resultBody(siblingId, toolResult), {
              headers: { "content-type": "application/json" },
            }),
          );
          expect((yield* Fiber.join(sibling)).outcome).toBe("completed");
        }
        expect((yield* connection.request({ action: "tools.call", tool: "later" })).outcome).toBe(
          "completed",
        );
        yield* connection.close;
        expect(getCancelled).toBe(true);
      }),
  );

  it.effect(
    "unconfirmed cancellation POST cleanup closes admission without aborting an admitted sibling",
    () =>
      Effect.gen(function* () {
        let slowSeen = false;
        let controlsSeen = 0;
        let controlAborted = false;
        let siblingAborted = false;
        let siblingId: number | undefined;
        let lateBodyCancelled = false;
        let releaseControl: ((response: Response) => void) | undefined;
        let releaseSibling: ((response: Response) => void) | undefined;
        const fetch = controlledFetch((init, message) => {
          if (message?.method === "notifications/cancelled") {
            controlsSeen += 1;
            init?.signal?.addEventListener(
              "abort",
              () => {
                controlAborted = true;
              },
              { once: true },
            );
            return Effect.runPromise(
              Effect.callback<Response>((resume) => {
                releaseControl = (response) => resume(Effect.succeed(response));
              }),
            );
          }
          if (message?.method !== "tools/call") return undefined;
          if (message.params?.name === "slow") {
            slowSeen = true;
            return Effect.runPromise(Effect.never, { signal: init?.signal ?? undefined });
          }
          if (message.params?.name !== "sibling") return undefined;
          siblingId = message.id;
          init?.signal?.addEventListener(
            "abort",
            () => {
              siblingAborted = true;
            },
            { once: true },
          );
          return Effect.runPromise(
            Effect.callback<Response>((resume) => {
              releaseSibling = (response) => resume(Effect.succeed(response));
            }),
          );
        });
        const connection = yield* openSdkHttp({
          url: fakeUrl,
          fetch,
          ...defaults,
          requestTimeoutMs: 20,
          cleanupTimeoutMs: 10,
        });
        const call = yield* Effect.forkChild(
          Effect.result(connection.request({ action: "tools.call", tool: "slow" })),
        );
        yield* yieldUntil(() => slowSeen);
        yield* TestClock.adjust(Duration.millis(20));
        yield* Fiber.join(call);
        yield* yieldUntil(() => releaseControl !== undefined);
        yield* TestClock.adjust(Duration.millis(15));
        const sibling = yield* Effect.forkChild(
          connection.request({ action: "tools.call", tool: "sibling" }),
        );
        yield* yieldUntil(() => releaseSibling !== undefined);
        yield* TestClock.adjust(Duration.millis(5));
        yield* yieldUntil(() => controlAborted);
        yield* TestClock.adjust(Duration.millis(10));
        const later = yield* Effect.result(
          connection.request({ action: "tools.call", tool: "late" }),
        );
        expect(Result.isFailure(later) && later.failure).toMatchObject({
          kind: "unavailable",
          outcome: "not-sent",
        });
        expect(siblingAborted).toBe(false);
        expect(controlsSeen).toBe(1);
        releaseSibling!(
          new Response(resultBody(siblingId, toolResult), {
            headers: { "content-type": "application/json" },
          }),
        );
        expect((yield* Fiber.join(sibling)).outcome).toBe("completed");
        releaseControl!(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                lateBodyCancelled = true;
              },
            }),
          ),
        );
        yield* yieldUntil(() => lateBodyCancelled);
        yield* Effect.result(connection.close);
      }),
  );

  it.effect("finalizes an interrupted initialization while its parent scope remains open", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<void>();
      let aborted = false;
      const fetch = controlledFetch((init, message) => {
        if (message?.method !== "initialize") return undefined;
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        Deferred.doneUnsafe(seen, Effect.void);
        return Effect.runPromise(Effect.never, { signal: init?.signal ?? undefined });
      });
      const cleanup: boolean[] = [];
      const opening = yield* Effect.forkChild(
        openSdkHttp({
          url: fakeUrl,
          fetch,
          ...defaults,
          onCleanup: (confirmed) => cleanup.push(confirmed),
        }),
      );
      yield* Deferred.await(seen);
      yield* Fiber.interrupt(opening);
      expect(aborted).toBe(true);
      expect(cleanup).toEqual([true]);
    }),
  );

  it.effect.each(["token", "header"])(
    "rotates and clears %s credentials only for future explicit calls",
    (source) =>
      Effect.gen(function* () {
        const authorization: Array<string | null> = [];
        const fetch = controlledFetch((init, message) => {
          if (message?.method !== "tools/call") return undefined;
          authorization.push(new Headers(init?.headers).get("authorization"));
          return authorization.length === 1
            ? Promise.resolve(new Response(null, { status: 401 }))
            : undefined;
        });
        const base = { url: fakeUrl, fetch, ...defaults };
        const connection = yield* openSdkHttp(
          source === "token"
            ? { ...base, token: "old" }
            : {
                ...base,
                headers: { Authorization: "Bearer old" },
              },
        );
        expect(
          yield* connection.request({ action: "tools.call", tool: "denied" }).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { kind: "auth-required", outcome: "unknown" },
        });
        yield* connection.setToken("new");
        expect(authorization).toEqual(["Bearer old"]);
        yield* connection.request({ action: "tools.call", tool: "next" });
        yield* connection.setToken(undefined);
        yield* connection.request({ action: "tools.call", tool: "anonymous" });
        expect(authorization).toEqual(["Bearer old", "Bearer new", null]);
        expect(yield* connection.health).toMatchObject({
          closed: false,
          cleanupUnconfirmed: false,
        });
        yield* connection.close;
        yield* connection.terminal;
        expect(yield* connection.setToken("late").pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
      }),
  );

  it.effect("keeps an accepted completed reply when source cancellation is unconfirmed", () =>
    Effect.gen(function* () {
      const cancelSeen = yield* Deferred.make<void>();
      const releaseCancel = yield* Deferred.make<void>();
      const cleanup: boolean[] = [];
      const fetch = controlledFetch((_init, message) => {
        if (message?.method !== "tools/call") return undefined;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  bytes(`event: message\ndata: ${resultBody(message.id, toolResult)}\n\n`),
                );
              },
              cancel() {
                Deferred.doneUnsafe(cancelSeen, Effect.void);
                return Effect.runPromise(Deferred.await(releaseCancel));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      });
      const connection = yield* openSdkHttp({
        url: fakeUrl,
        fetch,
        ...defaults,
        cleanupTimeoutMs: 20,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      });
      const request = yield* connection
        .request({ action: "tools.call", tool: "accepted" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(cancelSeen);
      yield* TestClock.adjust(Duration.millis(20));
      // Terminal evidence may arrive before the caller observes its accepted reply.
      expect(yield* connection.terminal.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "cleanup" },
      });
      expect(yield* Fiber.join(request)).toEqual({
        action: "tools.call",
        outcome: "completed",
        result: toolResult,
        cleanupUnconfirmed: true,
      });
      expect(yield* connection.health).toMatchObject({ closed: true, cleanupUnconfirmed: true });
      expect(
        yield* connection.request({ action: "tools.call", tool: "repeat" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { outcome: "not-sent" },
      });
      const close = yield* connection.close.pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(20));
      expect(yield* Fiber.join(close)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "cleanup" },
      });
      expect(cleanup).toEqual([false]);
      expect(yield* connection.terminal.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "cleanup" },
      });
      yield* Deferred.succeed(releaseCancel, undefined);
    }),
  );
});
