import { expect, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import { HttpServerResponse } from "effect/unstable/http";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { vi } from "vitest";
import { makeMcpLayer } from "../../../src/layer.ts";
import { McpExecution } from "../../../src/tools/service.ts";
import type { McpGatewayRequest } from "../../../src/tools/model.ts";
import { startHttpServer } from "../../fixtures/http-server.ts";
import {
  legacyInitialized,
  parseWire,
  rpcError,
  rpcResult,
  sseFrames,
  streamResponse,
} from "../../fixtures/json-rpc.ts";
import {
  SUBSCRIPTION_ID_META_KEY,
  Client,
  type FetchLike,
  type Transport,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { openSdkHttp } from "../../../src/boundary/sdk-http.ts";
import { makeSdkClient } from "../../../src/boundary/sdk-client.ts";
import { makeSdkEvents } from "../../../src/boundary/sdk-events.ts";
import { ownSubscription } from "../../../src/boundary/mcp-protocol/modern/subscriptions.ts";
import { boundaryError } from "../../../src/client/errors.ts";
import { getAuthChallenge, setAuthChallenge } from "../../../src/auth/challenge.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const url = new URL("https://fixture.test/mcp");
const defaults = { connectTimeoutMs: 500, requestTimeoutMs: 100, cleanupTimeoutMs: 200 };
const discovered = {
  supportedVersions: ["2026-07-28", "2025-11-25"],
  capabilities: { tools: {} },
  instructions: "untrusted modern instructions",
};
const response = (id: string | number, result: Schema.JsonObject) =>
  rpcResult(id, { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result });

it.live.each([
  "params",
  "missing-method",
  "lost-ack",
  "broken-send",
  "boundary",
  "legacy",
] as const)("preserves subscription certainty without HTTP traffic mapping: %s", (mode) =>
  Effect.gen(function* () {
    const client = yield* makeSdkClient(mode === "legacy" ? "legacy" : "auto");
    const events = yield* makeSdkEvents(client, {
      closing: false,
      closed: false,
      cleanupUnconfirmed: false,
    });
    const original = setAuthChallenge(boundaryError("auth-required", "unknown", "Rejected."), {
      status: 401,
      wwwAuthenticate: 'Bearer realm="private"',
    });
    let listens = 0;
    const transport: Transport = {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
      send: (message) =>
        Promise.resolve().then(() => {
          if (!("method" in message) || !("id" in message)) return;
          if (message.method === "server/discover" || message.method === "initialize") {
            transport.onmessage?.({
              jsonrpc: "2.0",
              id: message.id,
              result:
                mode === "legacy" ? legacyInitialized() : { resultType: "complete", ...discovered },
            });
          } else if (message.method === "subscriptions/listen") {
            listens++;
            if (mode === "boundary") throw original;
            if (mode === "broken-send") throw new Error("private unproven send failure");
            if (mode === "params" || mode === "missing-method")
              transport.onmessage?.({
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: mode === "params" ? -32602 : -32601,
                  message: "private server message",
                  data: { secret: "private server data" },
                },
              });
          }
        }),
    };
    yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
    yield* Effect.tryPromise(() => client.connect(events.bindTransport(transport)));
    const error = yield* Effect.scoped(
      ownSubscription(client, { resourcesListChanged: true }, events, 20, 100),
    ).pipe(Effect.flip);
    if (mode === "boundary") {
      expect(error).toBe(original);
      expect(getAuthChallenge(error)).toEqual(getAuthChallenge(original));
    } else {
      expect(error).toMatchObject(
        mode === "params"
          ? { kind: "protocol", outcome: "completed", reason: "rpc-invalid-params" }
          : mode === "missing-method"
            ? { kind: "unsupported", outcome: "completed", reason: "rpc-method-not-found" }
            : mode === "legacy"
              ? { kind: "unsupported", outcome: "not-sent" }
              : { kind: mode === "lost-ack" ? "timeout" : "transport", outcome: "unknown" },
      );
      expect(serialize(error)).not.toContain("private");
    }
    expect(listens).toBe(mode === "legacy" ? 0 : 1);
  }),
);

it.live.each(["lost-ack", "auth"] as const)(
  "HTTP subscription maps %s with its owned transport evidence and no replay",
  (mode) =>
    Effect.gen(function* () {
      let listens = 0;
      let cancelled = false;
      const challenge = 'Bearer realm="private", resource_metadata="https://fixture.test/meta"';
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          if (init?.method !== "POST") return new Response(null, { status: 405 });
          const request = parseWire(init.body);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return response(request.id, {
              ...discovered,
              capabilities: { resources: { subscribe: true } },
            });
          listens++;
          return mode === "auth"
            ? new Response(null, { status: 401, headers: { "www-authenticate": challenge } })
            : streamResponse(
                {
                  cancel() {
                    cancelled = true;
                  },
                },
                { headers: { "content-type": "text/event-stream" } },
              );
        });
      const connection = yield* openSdkHttp({ url, fetch, ...defaults, requestTimeoutMs: 20 });
      const error = yield* Effect.scoped(connection.subscribeResource("test://one")).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({
        kind: mode === "auth" ? "auth-required" : "timeout",
        outcome: "unknown",
      });
      if (mode === "auth")
        expect(getAuthChallenge(error)).toMatchObject({ status: 401, wwwAuthenticate: challenge });
      else expect(cancelled).toBe(true);
      expect(serialize(error)).not.toContain("private");
      expect(listens).toBe(1);
      yield* connection.close;
      expect((yield* connection.health).cleanupUnconfirmed).toBe(false);
    }),
);

it.live.each(["modern", "legacy"])(
  "runs %s discovery and all application request families through makeMcpLayer",
  (era) =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-mcp-modern-" });
      const agentDirectory = vi
        .spyOn(AgentDirectory, "layerFromHost")
        .mockReturnValue(AgentDirectory.layer(cwd));
      yield* Effect.addFinalizer(() => Effect.sync(() => agentDirectory.mockRestore()));
      const results = new Map<string, Schema.JsonObject>(
        Object.entries({
          "server/discover": {
            ...discovered,
            supportedVersions: [era === "modern" ? "2026-07-28" : "2025-11-25"],
            capabilities: { tools: {}, resources: {}, prompts: {} },
          },
          initialize: legacyInitialized({ tools: {}, resources: {}, prompts: {} }),
          "tools/list": { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
          "tools/call": { content: [{ type: "text", text: "called once" }] },
          "resources/list": { resources: [{ name: "one", uri: "fixture://one" }] },
          "resources/templates/list": { resourceTemplates: [] },
          "resources/read": { contents: [{ uri: "fixture://one", text: "resource" }] },
          "prompts/list": { prompts: [{ name: "one" }] },
          "prompts/get": {
            messages: [{ role: "user", content: { type: "text", text: "untrusted prompt" } }],
          },
        }),
      );
      const methods: string[] = [];
      const http = yield* startHttpServer((request) => {
        if (request.method !== "POST")
          return Effect.succeed(HttpServerResponse.empty({ status: 405 }));
        const message = parseWire(request.body);
        methods.push(message.method);
        if (message.id === undefined)
          return Effect.succeed(HttpServerResponse.empty({ status: 202 }));
        return Effect.succeed(
          HttpServerResponse.fromWeb(response(message.id, results.get(message.method)!)),
        );
      });
      yield* fs.writeFileString(
        `${cwd}/.mcp.json`,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          mcpServers: { fixture: { url: http.url.href, auth: false } },
        }),
      );
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        const requests: McpGatewayRequest[] = [
          { action: "tools.list", server: "fixture" },
          { action: "tools.call", server: "fixture", tool: "echo", arguments: {} },
          { action: "resources.list", server: "fixture" },
          { action: "resources.templates", server: "fixture" },
          { action: "resources.read", server: "fixture", uri: "fixture://one" },
          { action: "prompts.list", server: "fixture" },
          { action: "prompts.get", server: "fixture", prompt: "one" },
        ];
        for (const request of requests) {
          const result = yield* execution.execute(request, {
            maxOutputBytes: 8_192,
            images: false,
          });
          expect(result.reply.isError).toBe(false);
          expect(result.reply.outcome).toBe("completed");
        }
        expect(methods.includes("initialize")).toBe(era === "legacy");
        const status = yield* execution.execute(
          { action: "status" },
          { maxOutputBytes: 8_192, images: false },
        );
        expect(status.reply.data).toMatchObject({
          result: {
            servers: [
              {
                id: "fixture",
                protocolVersion: era === "modern" ? "2026-07-28" : "2025-11-25",
                observation: "active",
              },
            ],
          },
        });
        expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
        const closed = yield* execution.execute(
          { action: "disconnect", server: "fixture" },
          { maxOutputBytes: 8_192, images: false },
        );
        expect(closed.reply.isError).toBe(false);
      }).pipe(Effect.provide(makeMcpLayer({ cwd, projectTrusted: true, isTrusted: () => true })));
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
);

it.live.each(["modern", "dual", "legacy"] as const)(
  "negotiates %s-only/dual HTTP and executes once",
  (era) =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          if (init?.method !== "POST") return new Response(null, { status: 405 });
          const request = parseWire(init.body);
          methods.push(request.method);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return era === "legacy"
              ? rpcError(request.id, { code: -32601, message: "unknown" })
              : response(request.id, discovered);
          if (request.method === "initialize")
            return response(request.id, legacyInitialized({ tools: {} }));
          return response(request.id, { content: [{ type: "text", text: "done" }] });
        });
      const connection = yield* openSdkHttp({ url, fetch, ...defaults });
      expect(connection.protocolVersion).toBe(era === "legacy" ? "2025-11-25" : "2026-07-28");
      expect((yield* connection.request({ action: "tools.call", tool: "once" })).outcome).toBe(
        "completed",
      );
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
      expect(methods.includes("initialize")).toBe(era === "legacy");
      if (era !== "legacy") expect(connection.instructions?.text).toBe(discovered.instructions);
      yield* connection.close;
      expect((yield* connection.health).cleanupUnconfirmed).toBe(false);
    }),
);

it.live(
  "rejects managed bearer publication to remote plaintext without blocking anonymous HTTP",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          calls++;
          const request = parseWire(init?.body);
          return response(request.id!, discovered);
        });
      const plaintext = new URL("http://remote.test/mcp");
      expect(
        yield* openSdkHttp({ url: plaintext, fetch, token: "private", ...defaults }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ kind: "denied", outcome: "not-sent" });
      expect(calls).toBe(0);
      const connection = yield* openSdkHttp({ url: plaintext, fetch, ...defaults });
      expect(calls).toBe(1);
      expect(yield* connection.setToken("private").pipe(Effect.flip)).toMatchObject({
        kind: "denied",
        outcome: "not-sent",
      });
      expect(calls).toBe(1);
      yield* connection.close;
    }),
);

/** Answers everything after the probe as a legacy server, counting methods. */
const afterProbe = (probe: (request: ReturnType<typeof parseWire>) => Response) => {
  const methods: string[] = [];
  const fetch: FetchLike = (_url, init) =>
    Promise.resolve().then(() => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = parseWire(init.body);
      methods.push(request.method);
      if (request.method === "server/discover") return probe(request);
      if (request.id === undefined) return new Response(null, { status: 202 });
      return response(
        request.id,
        request.method === "initialize" ? legacyInitialized() : { content: [] },
      );
    });
  return { fetch, methods };
};

it.live.each([400, 401, 403, 404, 408, 422, 429, 500])(
  "classifies a probe answered with HTTP %i as the SDK does, never replaying a call",
  (status) =>
    Effect.gen(function* () {
      const { fetch, methods } = afterProbe(() => new Response("broken", { status }));
      const result = yield* openSdkHttp({ url, fetch, ...defaults }).pipe(Effect.result);
      // Authorization failures and server errors are not legacy evidence.
      if (status === 401 || status === 403 || status === 500) {
        expect(result._tag).toBe("Failure");
        expect(methods).toEqual(["server/discover"]);
        return;
      }
      if (result._tag !== "Success") throw new Error("Expected legacy fallback.");
      expect(result.success.protocolVersion).toBe("2025-11-25");
      expect(methods.slice(0, 2)).toEqual(["server/discover", "initialize"]);
      expect(methods).not.toContain("tools/call");
      yield* result.success.close;
    }),
);

it.live.each([
  "malformed",
  "server-error",
  "empty",
  "garbage",
  "future",
  "version-empty",
  "version-garbage",
  "version-future",
])("falls back to legacy after a %s probe reply unless only newer versions are offered", (mode) =>
  Effect.gen(function* () {
    const supported = mode.includes("empty")
      ? []
      : mode.includes("future")
        ? ["2027-01-01"]
        : ["garbage"];
    const { fetch, methods } = afterProbe((request) => {
      if (mode === "malformed") return response(request.id!, { supportedVersions: 3 });
      if (mode === "server-error")
        return rpcError(request.id!, { code: -32603, message: "failure" });
      if (mode.startsWith("version-"))
        return rpcError(request.id!, { code: -32022, message: "version", data: { supported } });
      return response(request.id!, { ...discovered, supportedVersions: supported });
    });
    const result = yield* openSdkHttp({ url, fetch, ...defaults }).pipe(Effect.result);
    // A typed version disagreement naming only revisions the SDK orders after 2026-07-28
    // (including unparseable ones) is not legacy evidence.
    if (mode === "version-future" || mode === "version-garbage") {
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "unsupported" } });
      expect(methods).toEqual(["server/discover"]);
      return;
    }
    if (result._tag !== "Success") throw new Error("Expected legacy fallback.");
    expect(result.success.protocolVersion).toBe("2025-11-25");
    expect(methods.slice(0, 2)).toEqual(["server/discover", "initialize"]);
    yield* result.success.close;
  }),
);

it.live(
  "keeps a metadata subscription beyond request timeout, then invalidates on stream loss",
  () =>
    Effect.gen(function* () {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let subscriptionId: string | number = "";
      const encoder = new TextEncoder();
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          if (init?.method !== "POST") return new Response(null, { status: 405 });
          const request = parseWire(init.body);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return response(request.id, {
              ...discovered,
              capabilities: { tools: { listChanged: true } },
            });
          if (request.method === "subscriptions/listen") {
            subscriptionId = request.id;
            return streamResponse(
              {
                start(value) {
                  controller = value;
                  value.enqueue(
                    sseFrames({
                      jsonrpc: "2.0",
                      method: "notifications/subscriptions/acknowledged",
                      params: {
                        notifications: { toolsListChanged: true },
                        _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id },
                      },
                    }),
                  );
                },
                cancel() {},
              },
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return response(request.id, { tools: [] });
        });
      const connection = yield* openSdkHttp({
        url,
        fetch,
        ...defaults,
        requestTimeoutMs: 20,
        responseBytes: 512,
      });
      const change = yield* Effect.forkScoped(Stream.runHead(connection.changes));
      controller!.enqueue(encoder.encode(": keepalive\n\n".repeat(2_000)));
      yield* Effect.sleep(80);
      expect(yield* connection.health).toMatchObject({ closed: false, observation: "active" });
      controller!.enqueue(
        sseFrames({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } },
        }),
      );
      expect((yield* Fiber.join(change))._tag).toBe("Some");
      controller!.close();
      expect((yield* connection.terminal.pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* connection.health).toMatchObject({ closed: true, observation: "failed" });
      yield* connection.close;
    }),
);

it.live("reports subscription close failure after still joining native transport cleanup", () =>
  Effect.gen(function* () {
    const listen = vi.spyOn(Client.prototype, "listen").mockResolvedValue({
      honoredFilter: { toolsListChanged: true },
      closed: Promise.resolve("local"),
      close: () => Promise.reject(new Error("fixture cleanup failure")),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => listen.mockRestore()));
    const fetch: FetchLike = (_url, init) =>
      Promise.resolve(
        response(parseWire(init?.body).id!, {
          ...discovered,
          capabilities: { tools: { listChanged: true } },
        }),
      );
    const cleanup: boolean[] = [];
    const connection = yield* openSdkHttp({
      url,
      fetch,
      ...defaults,
      onCleanup: (value) => cleanup.push(value),
    });
    expect(yield* connection.close.pipe(Effect.flip)).toMatchObject({ kind: "cleanup" });
    expect(cleanup).toEqual([false]);
    expect(yield* connection.health).toMatchObject({ closed: true, cleanupUnconfirmed: true });
  }),
);

it.live.each(["missing", "partial"])(
  "joins subscription cleanup after %s acknowledgement; honoring nothing still connects",
  (mode) =>
    Effect.gen(function* () {
      let cancelled = false;
      const cleanup: boolean[] = [];
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          const request = parseWire(init?.body);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return response(request.id, {
              ...discovered,
              capabilities: { tools: { listChanged: true } },
            });
          return streamResponse(
            {
              start(controller) {
                if (mode === "partial")
                  controller.enqueue(
                    sseFrames({
                      jsonrpc: "2.0",
                      method: "notifications/subscriptions/acknowledged",
                      params: {
                        notifications: {},
                        _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id },
                      },
                    }),
                  );
              },
              cancel() {
                cancelled = true;
              },
            },
            { headers: { "content-type": "text/event-stream" } },
          );
        });
      const result = yield* openSdkHttp({
        url,
        fetch,
        ...defaults,
        connectTimeoutMs: 80,
        onCleanup: (value) => cleanup.push(value),
      }).pipe(Effect.result);
      expect(cancelled).toBe(true);
      if (mode === "missing") {
        expect(result._tag).toBe("Failure");
        expect(cleanup).toEqual([true]);
        return;
      }
      // An empty honored filter is a legal subset: tools stay unobserved.
      if (result._tag !== "Success") throw new Error("Expected an unobserved connection.");
      yield* result.success.close;
      expect(cleanup).toEqual([true]);
    }),
);
