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
  SUBSCRIPTION_ID_META_KEY,
  Client,
  serializeMessage,
  type FetchLike,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { openSdkHttp } from "../../../src/boundary/sdk-http.ts";

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
);
const url = new URL("https://fixture.test/mcp");
const defaults = { connectTimeoutMs: 500, requestTimeoutMs: 100, cleanupTimeoutMs: 200 };
const discovered = {
  supportedVersions: ["2026-07-28", "2025-11-25"],
  capabilities: { tools: {} },
  instructions: "untrusted modern instructions",
};
const json = (body: string) =>
  new Response(body, { headers: { "content-type": "application/json" } });
const response = (id: string | number, result: Schema.JsonObject) =>
  json(
    serializeMessage({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result },
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
          initialize: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
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
        const message = decode(request.body);
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
          const request = decode(init.body);
          methods.push(request.method);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return era === "legacy"
              ? json(
                  serializeMessage({
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32601, message: "unknown" },
                  }),
                )
              : response(request.id, discovered);
          if (request.method === "initialize")
            return response(request.id, {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            });
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
          const request = decode(init?.body);
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

it.live.each([400, 401, 403, 404, 408, 422, 429, 500])(
  "does not downgrade or replay negotiation rejected with HTTP %i",
  (status) =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          if (init?.method === "POST") methods.push(decode(init.body).method);
          return new Response("broken", { status });
        });
      const result = yield* openSdkHttp({ url, fetch, ...defaults }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(methods).toEqual(["server/discover"]);
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
])("rejects %s probe replies rather than initializing legacy", (mode) =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const fetch: FetchLike = (_url, init) =>
      Promise.resolve().then(() => {
        const request = decode(init?.body);
        methods.push(request.method);
        const supported = mode.includes("empty")
          ? []
          : mode.includes("future")
            ? ["2027-01-01"]
            : ["garbage"];
        if (mode === "malformed") return response(request.id!, { supportedVersions: 3 });
        if (mode === "server-error")
          return json(
            serializeMessage({
              jsonrpc: "2.0",
              id: request.id!,
              error: { code: -32603, message: "failure" },
            }),
          );
        if (mode.startsWith("version-"))
          return json(
            serializeMessage({
              jsonrpc: "2.0",
              id: request.id!,
              error: { code: -32022, message: "version", data: { supported } },
            }),
          );
        return response(request.id!, { ...discovered, supportedVersions: supported });
      });
    expect((yield* openSdkHttp({ url, fetch, ...defaults }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(methods).toEqual(["server/discover"]);
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
          const request = decode(init.body);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return response(request.id, {
              ...discovered,
              capabilities: { tools: { listChanged: true } },
            });
          if (request.method === "subscriptions/listen") {
            subscriptionId = request.id;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(value) {
                  controller = value;
                  value.enqueue(
                    encoder.encode(
                      `data: ${serializeMessage({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: { toolsListChanged: true }, _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id } } }).trim()}\n\n`,
                    ),
                  );
                },
                cancel() {},
              }),
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
        encoder.encode(
          `data: ${serializeMessage({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } } }).trim()}\n\n`,
        ),
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
        response(decode(init?.body).id!, {
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
  "joins subscription cleanup after %s acknowledgement",
  (mode) =>
    Effect.gen(function* () {
      let cancelled = false;
      const cleanup: boolean[] = [];
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          const request = decode(init?.body);
          if (request.id === undefined) return new Response(null, { status: 202 });
          if (request.method === "server/discover")
            return response(request.id, {
              ...discovered,
              capabilities: { tools: { listChanged: true } },
            });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (mode === "partial")
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${serializeMessage({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: {}, _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id } } }).trim()}\n\n`,
                    ),
                  );
              },
              cancel() {
                cancelled = true;
              },
            }),
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
      expect(result._tag).toBe("Failure");
      expect(cancelled).toBe(true);
      expect(cleanup).toEqual([true]);
    }),
);
