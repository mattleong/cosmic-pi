import type { FetchLike, RequestId } from "@modelcontextprotocol/client";
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
import type { McpSettings } from "../../src/config/model.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { McpDiscovery } from "../../src/discovery/service.ts";
import { McpInteraction } from "../../src/interaction/service.ts";
import type { McpInteractionHost } from "../../src/interaction/model.ts";
import { McpResults } from "../../src/results/service.ts";
import { McpExecution } from "../../src/tools/service.ts";
import { legacyInitialized, parseWire, rpcResult, type FixtureRequest } from "./json-rpc.ts";
import { fakeAuth, fakeConfigStore, httpDefinition, testConfig, testServer } from "./services.ts";

export const reply = (id: RequestId, result: Schema.JsonObject) =>
  rpcResult(id, { resultType: "complete", ttlMs: 60_000, cacheScope: "private", ...result });
const legacyResources = legacyInitialized({ resources: { subscribe: true } });
export const legacyInitialize = (id: RequestId) => rpcResult(id, legacyResources);
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
  const config = testConfig({
    settings: { connectTimeoutMs: 1_000, idleTimeoutMs: 1_000, ...options.settings },
    servers: {
      fixture: testServer("fixture", {
        identity: "owned-fixture",
        definition: httpDefinition({ url: url.href, headers: options.headers ?? {} }),
      }),
    },
  });
  const auth = Layer.succeed(
    McpAuth,
    fakeAuth({ access: () => options.auth ?? Effect.succeed(undefined) }),
  );
  const activity = McpActivity.layer();
  const connections = McpConnections.layer({ isTrusted: () => trusted }).pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeConfigStore(config).layer,
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
        JsonSchemaValidator.layer,
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
