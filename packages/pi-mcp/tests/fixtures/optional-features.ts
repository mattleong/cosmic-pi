import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuth } from "../../src/auth/service.ts";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import { openSdkHttp } from "../../src/boundary/sdk-http.ts";
import { JsonSchemaValidator } from "../../src/boundary/schema-validator.ts";
import type { McpConnection } from "../../src/client/model.ts";
import type { McpBoundaryError } from "../../src/client/errors.ts";
import type * as Scope from "effect/Scope";
import type { McpResolvedConfig, McpSettings } from "../../src/config/model.ts";
import { McpConfigStore } from "../../src/config/store.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { McpDiscovery } from "../../src/discovery/service.ts";
import { McpInteraction } from "../../src/interaction/service.ts";
import type { McpInteractionHost } from "../../src/interaction/model.ts";
import { McpResults } from "../../src/results/service.ts";
import { McpExecution } from "../../src/tools/service.ts";

export const wireSchema = Schema.Struct({
  _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  method: Schema.String,
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type FixtureRequest = typeof wireSchema.Type;
export const parseWire = (body: BodyInit | null | undefined) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(wireSchema))(body);
export const reply = (id: string | number, result: Schema.JsonObject) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", ...result },
    }),
    { headers: { "content-type": "application/json" } },
  );
export const discovered = (
  capabilities: Schema.JsonObject = {
    tools: {},
    resources: { subscribe: true },
    prompts: {},
    completions: {},
    logging: {},
  },
) => ({ supportedVersions: ["2026-07-28"], capabilities });
export const projection = { maxOutputBytes: 32_768, images: false };
export const defaultResult = (request: FixtureRequest): Schema.JsonObject => {
  switch (request.method) {
    case "server/discover":
      return discovered();
    case "tools/list":
      return { tools: [{ name: "example", inputSchema: { type: "object" } }] };
    case "resources/list":
      return { resources: [{ name: "one", uri: "test://one" }] };
    case "resources/templates/list":
      return { resourceTemplates: [{ name: "path", uriTemplate: "test://{path}" }] };
    case "prompts/list":
      return { prompts: [{ name: "example", arguments: [{ name: "value" }] }] };
    case "resources/read":
      return { contents: [{ uri: "test://one", text: "done" }] };
    case "prompts/get":
      return { messages: [{ role: "user", content: { type: "text", text: "done" } }] };
    case "completion/complete":
      return { completion: { values: ["one", "two"] } };
    default:
      return { content: [{ type: "text", text: "done" }] };
  }
};

/** Owned configuration/auth boundaries, actual execution/discovery/SDK transport/retention. */
export const optionalFixture = (
  handle: (
    request: FixtureRequest,
    init: RequestInit | undefined,
  ) => Response | Promise<Response> | undefined = () => undefined,
  options: {
    readonly interaction?: McpInteractionHost;
    readonly settings?: Partial<McpSettings>;
    readonly auth?: Effect.Effect<string | undefined, McpBoundaryError>;
    readonly open?: Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly protocol?: "auto" | "legacy";
    readonly mapConnection?: (connection: McpConnection) => McpConnection;
  } = {},
) => {
  const requests: FixtureRequest[] = [];
  const headers: Headers[] = [];
  let opens = 0;
  let trusted = true;
  const url = new URL("https://owned.test/mcp");
  const fetch: FetchLike = (_url, init) =>
    Promise.resolve().then(() => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = parseWire(init.body);
      requests.push(request);
      headers.push(new Headers(init.headers));
      if (request.id === undefined) return new Response(null, { status: 202 });
      const id = request.id;
      return Promise.resolve(handle(request, init)).then(
        (response) => response ?? reply(id, defaultResult(request)),
      );
    });
  const config: McpResolvedConfig = {
    revision: 1,
    trusted: true,
    diagnostics: [],
    settings: {
      enabled: true,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 60_000,
      idleTimeoutMs: 1_000,
      maxConcurrent: 8,
      maxPerServer: 4,
      maxQueued: 64,
      ...options.settings,
    },
    servers: {
      fixture: {
        id: "fixture",
        identity: "owned-fixture",
        enabled: true,
        scope: "global",
        directory: "/fixture",
        definition: {
          transport: "http",
          url: url.href,
          headers: options.headers ?? {},
          auth: { type: "none" },
          denyTools: [],
        },
      },
    },
  };
  const configLayer = Layer.succeed(McpConfigStore, {
    snapshot: Effect.succeed(config),
    subscribe: (listener) => listener(config),
    reload: Effect.succeed(config),
    setServer: () => Effect.succeed(config),
    removeServer: () => Effect.succeed(config),
    setSettings: () => Effect.succeed(config),
  });
  const auth = Layer.succeed(McpAuth, {
    access: () => options.auth ?? Effect.succeed(undefined),
    status: () => Effect.succeed({ state: "none" }),
    login: () => Effect.succeed({ state: "none" }),
    logout: () => Effect.void,
    reject: () => Effect.void,
    completeLogin: () => Effect.void,
    finalizationFailed: () => Effect.void,
    revoke: Effect.void,
  });
  const activity = McpActivity.layer();
  const connections = McpConnections.layer({ isTrusted: () => trusted }).pipe(
    Layer.provide(
      Layer.mergeAll(
        configLayer,
        auth,
        activity,
        Layer.succeed(McpConnector, {
          open: () =>
            Effect.suspend(() => {
              opens++;
              return (
                options.open ??
                openSdkHttp({
                  protocol: options.protocol ?? "auto",
                  url,
                  fetch,
                  headers: options.headers ?? {},
                  connectTimeoutMs: 1_000,
                  requestTimeoutMs: config.settings.requestTimeoutMs,
                  cleanupTimeoutMs: 200,
                })
              ).pipe(Effect.map((connection) => options.mapConnection?.(connection) ?? connection));
            }),
        }),
      ),
    ),
  );
  const discovery = McpDiscovery.layer.pipe(Layer.provide(Layer.mergeAll(connections, activity)));
  const execution = McpExecution.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        connections,
        discovery,
        auth,
        McpResults.layer(),
        JsonSchemaValidator.layer(),
        McpInteraction.layer(options.interaction),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(execution, connections),
    requests,
    headers,
    opens: () => opens,
    revokeTrust: () => {
      trusted = false;
    },
  };
};
