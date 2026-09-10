import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { invokeHostCallback, makeSynchronousIngress } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import { McpConnections } from "../connection/service.ts";
import type { McpActionBinding } from "../connection/model.ts";
import { McpDiscovery } from "../discovery/service.ts";
import { McpExecution } from "../tools/service.ts";
import { McpResults } from "../results/service.ts";
import type { McpManagerContract, McpManagerServer, McpManagerSnapshot } from "./model.ts";
import { serverActions } from "./policy.ts";

const empty: McpManagerSnapshot = Object.freeze({
  revision: 0,
  trusted: false,
  enabled: false,
  active: 0,
  queued: 0,
  servers: [],
});
const stale = () =>
  boundaryError("stale", "not-sent", "MCP selection changed. Open the action again.");

const makeManager = Effect.gen(function* () {
  const connections = yield* McpConnections;
  const discovery = yield* McpDiscovery;
  const execution = yield* McpExecution;
  const results = yield* McpResults;
  const projection = yield* SynchronizedRef.make(empty);
  const alive = yield* Ref.make(true);
  const viewPermit = yield* Semaphore.make(1);
  const listeners = new Set<() => void>();
  // Exact displayed object identity authorizes ticket capture without publishing hashes.
  const bindings = new WeakMap<McpManagerServer, McpActionBinding>();
  // These latches belong to synchronous invalidation ingress, not to service authority.
  let generation = 0;
  let publishedGeneration = -1;
  let closed = false;
  const notify = () => {
    const currentListeners = Array.from(listeners);
    for (const listener of currentListeners) {
      if (listeners.has(listener)) invokeHostCallback(listener, undefined);
    }
  };
  const refresh = Effect.gen(function* () {
    const requested = generation;
    const config = yield* connections.config;
    const status = yield* connections.status;
    const known = config.trusted && config.settings.enabled ? yield* discovery.known : [];
    if (config.revision !== status.revision || requested !== generation || !(yield* Ref.get(alive)))
      return SynchronizedRef.getUnsafe(projection);
    const servers = status.servers
      .filter((server) => status.trusted || server.scope === "global")
      .map((server): McpManagerServer => {
        const effective = config.servers[server.id]!;
        const definition = effective.definition;
        const row = {
          ...server,
          transport: definition?.transport ?? ("invalid" as const),
          invalid: definition === undefined || effective.diagnostic !== undefined,
          authType: definition?.transport === "http" ? definition.auth.type : ("none" as const),
          metadata: known.find((summary) => summary.server === server.id),
          configRevision: status.revision,
        };
        const displayed = Object.freeze({
          ...row,
          actions: Object.freeze(serverActions(row, status.trusted, status.enabled)),
        });
        bindings.set(
          displayed,
          Object.freeze({
            server: server.id,
            identity: effective.identity,
            configRevision: status.revision,
            operationRevision: server.operationRevision,
          }),
        );
        return displayed;
      });
    const snapshot: McpManagerSnapshot = Object.freeze({
      revision: status.revision,
      trusted: status.trusted,
      enabled: status.enabled,
      active: status.active,
      queued: status.queued,
      servers: Object.freeze(servers),
    });
    yield* SynchronizedRef.set(projection, snapshot);
    publishedGeneration = requested;
    notify();
    return snapshot;
  });
  const ingress = yield* makeSynchronousIngress({
    capacity: 1,
    overflow: "coalesce-latest",
    handle: () => refresh.pipe(Effect.asVoid),
  }).pipe(Effect.orDie);
  const invalidate = () => {
    if (closed) return;
    generation += 1;
    // Consumers discard metadata immediately, before the coalesced refresh can yield.
    notify();
    ingress.offer(undefined);
  };
  yield* connections.subscribeChanges(invalidate);
  yield* discovery.subscribeChanges(invalidate);
  yield* results.subscribeChanges(invalidate);
  yield* refresh;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* Ref.set(alive, false);
      yield* SynchronizedRef.set(projection, empty);
      notify();
      listeners.clear();
    }),
  );
  const snapshot = (): McpManagerSnapshot => {
    const value = SynchronizedRef.getUnsafe(projection);
    if (closed) return empty;
    if (!connections.isAvailable())
      return {
        ...value,
        trusted: false,
        servers: value.servers.map((row) => ({
          ...row,
          metadata: undefined,
          actions: serverActions(row, false, value.enabled),
        })),
      };
    if (generation !== publishedGeneration)
      return { ...value, servers: value.servers.map((row) => ({ ...row, metadata: undefined })) };
    return value;
  };
  const check: McpManagerContract["check"] = (ticket) =>
    Effect.gen(function* () {
      if (closed) return yield* stale();
      yield* connections.checkAction(ticket.binding);
      const fresh = yield* refresh;
      const row = fresh.servers.find((entry) => entry.id === ticket.binding.server);
      if (!row?.actions.some((choice) => choice.action === ticket.action && choice.enabled))
        return yield* stale();
      yield* connections.checkAction(ticket.binding);
    });
  return {
    refresh,
    snapshot,
    withView: (effect) =>
      effect.pipe(
        viewPermit.withPermitsIfAvailable(1),
        Effect.flatMap((result) =>
          Effect.fromOption(result).pipe(
            Effect.mapError(() =>
              boundaryError("busy", "not-sent", "The MCP manager is already open."),
            ),
          ),
        ),
      ),
    subscribe: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    capture: (row, action) =>
      Effect.gen(function* () {
        const choice = row.actions.find((item) => item.action === action);
        if (!choice?.enabled)
          return yield* boundaryError("denied", "not-sent", "MCP action is not available.");
        const binding = bindings.get(row);
        if (!binding) return yield* stale();
        const ticket = Object.freeze({ binding, action, confirmation: choice.confirmation });
        yield* check(ticket);
        return ticket;
      }),
    check,
    dispatch: (ticket) =>
      Effect.gen(function* () {
        yield* check(ticket);
        switch (ticket.action) {
          case "connect":
            yield* connections.connect(ticket.binding.server, ticket.binding);
            break;
          case "refresh":
            yield* connections.withOperation(
              ticket.binding.server,
              { expected: ticket.binding },
              (operation) => discovery.refresh(operation),
            );
            break;
          case "disconnect": {
            const receipt = yield* connections.disconnect(ticket.binding.server, ticket.binding);
            if (receipt.cleanup === "unconfirmed")
              return yield* boundaryError(
                "cleanup",
                "not-sent",
                "MCP connection cleanup is unconfirmed.",
              );
            break;
          }
          case "logout":
            yield* execution.logout(ticket.binding.server, ticket.binding);
            break;
          default:
            return yield* boundaryError(
              "invalid-input",
              "not-sent",
              "This action requires its user view.",
            );
        }
        const config = yield* connections.config;
        if (
          config.revision !== ticket.binding.configRevision ||
          config.servers[ticket.binding.server]?.identity !== ticket.binding.identity
        )
          return yield* stale();
        yield* refresh;
      }),
    cached: discovery.cached,
    cachedDetail: discovery.cachedDetail,
  } satisfies McpManagerContract;
});

export class McpManager extends Context.Service<McpManager, McpManagerContract>()(
  "pi-mcp/manager/service/McpManager",
) {
  static readonly layer = Layer.effect(McpManager, makeManager);
}
