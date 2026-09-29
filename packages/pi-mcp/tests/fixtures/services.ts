import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import type { McpAuthContract } from "../../src/auth/model.ts";
import { boundaryError, type McpBoundaryError } from "../../src/client/errors.ts";
import type { McpConnection, McpReply, McpRequest } from "../../src/client/model.ts";
import type {
  McpConfigStoreContract,
  McpEffectiveServer,
  McpResolvedConfig,
  McpServerDefinition,
  McpSettings,
} from "../../src/config/model.ts";
import { DEFAULT_MCP_SETTINGS } from "../../src/config/schema.ts";
import { McpConfigStore } from "../../src/config/store.ts";
import type { McpOperation } from "../../src/connection/model.ts";
import type { McpDiscoveryContract, McpMetadataSnapshot } from "../../src/discovery/model.ts";

// Override-first service fakes. Callers pass every value their assertions or leak checks read.
type Definition<Transport> = Extract<McpServerDefinition, { readonly transport: Transport }>;

export const testSettings = (overrides: Partial<McpSettings> = {}): McpSettings => ({
  ...DEFAULT_MCP_SETTINGS,
  ...overrides,
});
export const stdioDefinition = (
  overrides: Partial<Definition<"stdio">> = {},
): Definition<"stdio"> => ({
  transport: "stdio",
  command: "fixture",
  args: [],
  environment: {},
  denyTools: [],
  ...overrides,
});
export const httpDefinition = (
  overrides: Partial<Definition<"http">> = {},
): Definition<"http"> => ({
  transport: "http",
  url: "https://example.test/mcp",
  headers: {},
  auth: { type: "none" },
  denyTools: [],
  ...overrides,
});
export const testServer = (
  id: string,
  overrides: Partial<McpEffectiveServer> = {},
): McpEffectiveServer => ({
  id,
  identity: `identity-${id}`,
  // Auth fixtures key credentials by the configured identity unless a test separates them.
  credentialIdentity: overrides.identity ?? `identity-${id}`,
  scope: "global",
  directory: "/fixture",
  enabled: true,
  definition: stdioDefinition(),
  ...overrides,
});
export const testConfig = (
  overrides: Partial<Omit<McpResolvedConfig, "settings">> & {
    readonly settings?: Partial<McpSettings> | undefined;
  } = {},
): McpResolvedConfig => ({
  revision: 1,
  trusted: true,
  diagnostics: [],
  servers: {},
  ...overrides,
  settings: testSettings(overrides.settings),
});

/** A generator test body receives `services`; `layer` is provided once at the entry point. */
export const runWith =
  <S, E, R, LE, LR>(services: Effect.Effect<S, E, R>, layer: Layer.Layer<R, LE, LR>) =>
  <Eff extends Effect.Effect<unknown, unknown, unknown>, A>(
    body: (services: S) => Generator<Eff, A, unknown>,
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* services);
    }).pipe(Effect.provide(layer));

/** Anonymous auth without credential state. */
export const fakeAuth = (overrides: Partial<McpAuthContract> = {}): McpAuthContract => ({
  access: () => Effect.succeed(undefined),
  status: () => Effect.succeed({ state: "none" }),
  login: () => Effect.succeed({ state: "ready" }),
  logout: () => Effect.void,
  reject: () => Effect.void,
  finishLogin: () => Effect.void,
  revoke: Effect.void,
  ...overrides,
});

/** Production subscribe semantics: publish the current value, then keep one subscriber. */
export const fakeConfigStore = (
  initial: McpResolvedConfig,
  overrides: Partial<McpConfigStoreContract> = {},
) => {
  let config = initial;
  let subscriber: ((next: McpResolvedConfig) => Effect.Effect<void>) | undefined;
  const snapshot = Effect.sync(() => config);
  return {
    current: () => config,
    /** Replaces the value, then notifies the current subscriber. */
    publish: (next: McpResolvedConfig) =>
      Effect.suspend(() => {
        config = next;
        return (subscriber?.(next) ?? Effect.void).pipe(Effect.as(next));
      }),
    layer: Layer.succeed(McpConfigStore, {
      snapshot,
      subscribe: (listener) =>
        Effect.gen(function* () {
          yield* listener(config);
          subscriber = listener;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (subscriber === listener) subscriber = undefined;
            }),
          );
        }),
      reload: snapshot,
      setServer: () => snapshot,
      removeServer: () => snapshot,
      setSettings: () => snapshot,
      ...overrides,
    }),
  };
};

const completed = (input: McpRequest) =>
  Effect.succeed<McpReply>({ action: input.action, outcome: "completed", result: {} });
const unsupportedSubscription = () =>
  Effect.fail(
    boundaryError("unsupported", "not-sent", "Fixture resource subscriptions are unsupported."),
  );

/**
 * Request-first connection: `exchange` completes `request`, and a completed terminal reports
 * closed health. The function form exposes the terminal. Close also runs at scope end.
 */
export const fakeConnection = (
  overrides:
    | Partial<McpConnection>
    | ((terminal: Deferred.Deferred<void, McpBoundaryError>) => Partial<McpConnection>) = {},
) =>
  Effect.gen(function* () {
    const terminal = yield* Deferred.make<void, McpBoundaryError>();
    const custom = Predicate.isFunction(overrides) ? overrides(terminal) : overrides;
    const request = custom.request ?? completed;
    const connection: McpConnection = {
      capabilities: { tools: true, resources: false, prompts: false },
      changes: Stream.never,
      remoteEvents: Stream.empty,
      remoteEventDrops: Effect.succeed(0),
      terminal: Deferred.await(terminal),
      health: Deferred.isDone(terminal).pipe(
        Effect.map((closed) => ({ closed, cleanupUnconfirmed: false })),
      ),
      setToken: () => Effect.void,
      subscribeResource: unsupportedSubscription,
      exchange: (input, options) =>
        request(input, options).pipe(Effect.map((reply) => ({ kind: "complete", reply }))),
      close: Deferred.succeed(terminal, undefined).pipe(Effect.asVoid),
      ...custom,
      request,
    };
    yield* Effect.addFinalizer(() => Effect.ignore(connection.close));
    return connection;
  });

/** Request-first operation: `exchange` completes `request`; continuation checks `checkCurrent`. */
export const fakeOperation = (overrides: Partial<McpOperation> = {}): McpOperation => {
  const server = overrides.server ?? testServer("a", { identity: "identity" });
  const checkCurrent = overrides.checkCurrent ?? Effect.void;
  const request = overrides.request ?? completed;
  const operation: McpOperation = {
    binding: {
      server: server.id,
      identity: server.identity,
      configRevision: 1,
      authorizationRevision: 0,
    },
    server,
    owner: "connection",
    operationId: "connection:operation",
    capabilities: { tools: true, resources: true, prompts: true },
    changes: Stream.never,
    checkCurrent,
    checkContinuation: checkCurrent,
    commit: (publication) => checkCurrent.pipe(Effect.andThen(publication)),
    subscribeResource: unsupportedSubscription,
    exchange: (input, options) =>
      request(input, options).pipe(Effect.map((reply) => ({ kind: "complete", reply }))),
    shared: (_key, use) => use(operation),
    forkOwned: (effect) => Effect.forkChild(effect),
    ...overrides,
    request,
  };
  return operation;
};

/** Discovery with no cached metadata; `ensure` and `refresh` read the current `snapshot`. */
export const fakeDiscovery = (
  snapshot: () => McpMetadataSnapshot,
  overrides: Partial<McpDiscoveryContract> = {},
): McpDiscoveryContract => ({
  cached: (request) =>
    Effect.succeed({
      family: request.family,
      entries: [],
      catalogs: [],
      total: 0,
      next: undefined,
    }),
  cachedDetail: () => Effect.fail(boundaryError("not-found", "not-sent", "fixture")),
  subscribeChanges: () => Effect.void,
  ensure: () => Effect.sync(snapshot),
  refresh: () => Effect.sync(snapshot),
  query: () => Effect.succeed({ data: {}, notices: [] }),
  known: Effect.succeed([]),
  ...overrides,
});
