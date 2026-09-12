import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { makeResourceSubscriptions } from "../resources/subscriptions.ts";
import { makeObservations } from "../observations/service.ts";
import type { McpActivityContract } from "../activity/service.ts";
import type { McpActivityHandle, McpActivityFailure } from "../activity/model.ts";
import type { McpAuthContract, McpAuthRejection } from "../auth/model.ts";
import { withAuthFailureReason } from "../auth/diagnostics.ts";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";
import type { McpConnection } from "../client/model.ts";
import type { McpConfigStoreContract, McpEffectiveServer, McpSettings } from "../config/model.ts";
import { McpAdmission, type AdmissionTicket } from "./admission.ts";
import type {
  McpActionBinding,
  McpConnectionReceipt,
  McpConnectionsOptions,
  McpConnectionStatus,
  McpRevocationListener,
  McpRevocationReason,
} from "./model.ts";

export interface ConnectionOwner {
  readonly id: string;
  readonly server: McpEffectiveServer;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<McpConnection, McpBoundaryError>;
  readonly cleaned: Deferred.Deferred<"confirmed" | "unconfirmed">;
  readonly shared: Map<string, Deferred.Deferred<unknown, McpBoundaryError>>;
  state: "connecting" | "connected" | "closing" | "blocked";
  current: boolean;
  accepting: boolean;
  operations: number;
  leases: number;
  authorizationRevision: number;
  /** Credential equality stays private to the actual transport owner. */
  authorizationToken: string | undefined;
  idleGeneration: number;
  idle?: Fiber.Fiber<void>;
  connection?: McpConnection;
  uncertain: boolean;
  activity?: McpActivityHandle;
  failure?: McpActivityFailure;
}
export interface AuthSuspension {
  readonly server: McpEffectiveServer;
  readonly revision: number;
  readonly done: Deferred.Deferred<void>;
  running: boolean;
}
export interface RegistryConnector {
  readonly open: (
    server: McpEffectiveServer,
    settings: McpSettings,
    token?: string,
  ) => Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope>;
}

const stale = (outcome: McpBoundaryError["outcome"] = "not-sent") =>
  boundaryError("stale", outcome, "MCP operation authority was revoked.");

/** Private authoritative registry. Every transition and local publication holds one lock. */
export const makeRegistry = Effect.fn("McpConnections.registry")(function* (
  options: McpConnectionsOptions,
  store: McpConfigStoreContract,
  auth: McpAuthContract,
  connector: RegistryConnector,
  activity: McpActivityContract,
) {
  const observations = yield* makeObservations;
  const sessionScope = yield* Effect.scope;
  const resources = yield* Scope.fork(sessionScope);
  const monitors = yield* Scope.fork(sessionScope);
  const lock = yield* Semaphore.make(1);
  const withLock = Semaphore.withPermit(lock);
  let config = yield* store.snapshot;
  let closed = false;
  let sequence = 0;
  const owners = new Map<string, ConnectionOwner>();
  // Diagnostic only, bounded by current configured identities; no remote data retained.
  const observationFailures = new Map<string, string>();
  const suspensions = new Map<string, AuthSuspension>();
  const listeners = new Set<McpRevocationListener>();
  const changes = new Set<() => void>();
  let operationRevision = 0;
  const changed = () => {
    operationRevision += 1;
    for (const listener of changes) listener();
  };
  const admission = new McpAdmission(() => config.settings, changed);
  const publishRevocation = (ids: ReadonlyArray<string>, reason: McpRevocationReason) =>
    Effect.sync(() => observations.revoke(ids)).pipe(
      Effect.andThen(
        Effect.forEach(listeners, (listener) => listener(ids, reason), { discard: true }),
      ),
    );

  const cleanup = (owner: ConnectionOwner) =>
    Effect.gen(function* () {
      // Join acquisition and its finalizers before reading the captured connection.
      // Cleanup owns its lifetime independently of the disconnect waiter.
      yield* Scope.close(owner.scope, Exit.void);
      let uncertain = false;
      if (owner.connection) {
        const result = yield* Effect.exit(owner.connection.close);
        const health = yield* owner.connection.health;
        uncertain = Exit.isFailure(result) || health.cleanupUnconfirmed || !health.closed;
      }
      if (owner.activity)
        yield* activity.finish(
          owner.activity,
          owner.failure
            ? { ...owner.failure, status: "failed" }
            : owner.uncertain || uncertain
              ? { status: "failed", kind: "cleanup" }
              : { status: "cancelled" },
        );
      yield* withLock(
        Effect.sync(() => {
          owner.uncertain ||= uncertain;
          if (owners.get(owner.server.id) === owner) {
            if (owner.uncertain) owner.state = "blocked";
            else owners.delete(owner.server.id);
          }
          changed();
          Deferred.doneUnsafe(
            owner.cleaned,
            Effect.succeed(owner.uncertain ? "unconfirmed" : "confirmed"),
          );
        }),
      );
    });

  /** Must be called under lock. It starts owned cleanup but does not join remote work. */
  const retire = (owner: ConnectionOwner): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!owner.current) return;
      owner.current = false;
      owner.accepting = false;
      owner.state = "closing";
      if (owner.activity) yield* activity.update(owner.activity, { phase: "stopping" });
      owner.idleGeneration += 1;
      changed();
      yield* publishRevocation([owner.server.id], "connection");
      admission.revoke(owner.server.id);
      Deferred.doneUnsafe(owner.ready, Effect.fail(stale()));
      yield* Effect.forkIn(Effect.uninterruptible(cleanup(owner)), monitors);
    });

  // A terminal transport cannot accept another dispatch, but accepted responses still
  // own their bounded local validation/publication. Policy revocation remains separate.
  const terminalLocked = (owner: ConnectionOwner, uncertain = false) =>
    Effect.gen(function* () {
      owner.uncertain ||= uncertain;
      owner.accepting = false;
      changed();
      yield* publishRevocation([owner.server.id], "connection");
      if (owner.current) owner.state = "closing";
      owner.idleGeneration += 1;
      if (owner.operations === 0) yield* retire(owner);
    });
  const acceptingLocked = (owner: ConnectionOwner) =>
    owner.accepting
      ? Effect.void
      : Effect.fail(
          boundaryError(
            owner.uncertain ? "cleanup" : "connection",
            "not-sent",
            "MCP connection cannot accept another request.",
          ),
        );

  const revokeLocked = (
    ids: ReadonlyArray<string>,
    evict: boolean,
    reason: McpRevocationReason = "authority",
  ) =>
    Effect.gen(function* () {
      const retired: Array<ConnectionOwner> = [];
      for (const id of ids) {
        admission.revoke(id);
        const owner = owners.get(id);
        if (owner) {
          yield* retire(owner);
          retired.push(owner);
        }
      }
      if (evict && ids.length > 0) yield* publishRevocation(ids, reason);
      return retired;
    });

  const trustLocked = Effect.gen(function* () {
    if (config.trusted && !options.isTrusted()) {
      config = { ...config, trusted: false };
      observationFailures.clear();
      yield* revokeLocked(Object.keys(config.servers), true);
    }
  });

  const serverLocked = (id: string, tool?: string) =>
    Effect.gen(function* () {
      yield* trustLocked;
      if (closed || !config.trusted || !options.isTrusted() || !config.settings.enabled) {
        return yield* boundaryError(
          "denied",
          "not-sent",
          "MCP execution is not enabled in this trusted session.",
        );
      }
      const server = config.servers[id];
      if (!server)
        return yield* boundaryError("not-found", "not-sent", "MCP server is not configured.");
      if (!server.enabled || !server.definition) {
        return yield* boundaryError("denied", "not-sent", "MCP server is disabled or invalid.");
      }
      if (
        tool !== undefined &&
        (server.definition.denyTools.includes(tool) ||
          (server.definition.allowTools !== undefined &&
            !server.definition.allowTools.includes(tool)))
      )
        return yield* boundaryError("denied", "not-sent", "MCP tool is not allowed.");
      return server;
    });

  const checkActionLocked = (expected: McpActionBinding) =>
    Effect.gen(function* () {
      const server = yield* serverLocked(expected.server);
      if (
        server.identity !== expected.identity ||
        config.revision !== expected.configRevision ||
        operationRevision !== expected.operationRevision
      )
        return yield* stale();
    });

  const executionServerLocked = (id: string, tool?: string) =>
    Effect.gen(function* () {
      const server = yield* serverLocked(id, tool);
      if (suspensions.has(id))
        return yield* boundaryError(
          "busy",
          "not-sent",
          "MCP execution is suspended for user authentication.",
        );
      return server;
    });

  const ownerCheckLocked = (owner: ConnectionOwner, tool?: string) =>
    Effect.gen(function* () {
      const current = yield* executionServerLocked(owner.server.id, tool);
      if (
        !owner.current ||
        owners.get(current.id) !== owner ||
        current.identity !== owner.server.identity
      ) {
        return yield* stale();
      }
    });
  const checkLocked = (
    ticket: AdmissionTicket,
    owner: ConnectionOwner,
    tool?: string,
    revision?: number,
  ) =>
    Effect.gen(function* () {
      yield* ownerCheckLocked(owner, tool);
      if (revision !== undefined && revision !== config.revision)
        return yield* stale(ticket.outcome);
      if (!ticket.current) return yield* stale(ticket.outcome);
      if ((yield* Clock.currentTimeMillis) >= ticket.deadline) {
        return yield* boundaryError("timeout", ticket.outcome, "MCP operation deadline expired.");
      }
    }).pipe(Effect.mapError((error) => boundaryError(error.kind, ticket.outcome, error.message)));

  const access = auth.access;
  const checkTokenLocked = (owner: ConnectionOwner, token: string | undefined) =>
    Effect.gen(function* () {
      yield* ownerCheckLocked(owner);
      if (token === owner.authorizationToken) return;
      owner.authorizationRevision += 1;
      // A refreshed credential never inherits schemas or invocation authority. Leave
      // accepted replies their certainty, but stop all subsequent dispatches.
      yield* publishRevocation([owner.server.id], "credential");
      yield* terminalLocked(owner);
      return yield* stale();
    });
  const rejectAuthLocked = (owner: ConnectionOwner, evidence: McpAuthRejection) =>
    Effect.gen(function* () {
      if (
        closed ||
        !config.trusted ||
        !config.settings.enabled ||
        !options.isTrusted() ||
        !owner.current ||
        owners.get(owner.server.id) !== owner ||
        config.servers[owner.server.id]?.identity !== owner.server.identity
      )
        return;
      yield* auth.reject(owner.server, evidence);
      // Queued dispatches must stop even when the transport itself remains healthy.
      // Do not revoke the rejected ticket or replace its original outcome.
      yield* terminalLocked(owner);
    });

  const scheduleIdleLocked = (owner: ConnectionOwner): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (
        !owner.current ||
        owner.operations !== 0 ||
        owner.leases !== 0 ||
        owner.state !== "connected"
      )
        return;
      const generation = ++owner.idleGeneration;
      if (owner.idle) yield* Effect.forkIn(Fiber.interrupt(owner.idle), monitors);
      owner.idle = yield* Effect.forkIn(
        Effect.interruptible(
          Effect.sleep(config.settings.idleTimeoutMs).pipe(
            Effect.andThen(
              withLock(
                Effect.gen(function* () {
                  if (
                    owner.current &&
                    owner.operations === 0 &&
                    owner.leases === 0 &&
                    owner.idleGeneration === generation &&
                    owners.get(owner.server.id) === owner
                  ) {
                    yield* retire(owner);
                  }
                }),
              ),
            ),
          ),
        ),
        owner.scope,
      );
    });

  const resourceSubscriptions = yield* makeResourceSubscriptions({
    check: (owner) =>
      withLock(ownerCheckLocked(owner).pipe(Effect.andThen(acceptingLocked(owner)))),
    lease: (owner, delta) =>
      withLock(
        Effect.gen(function* () {
          owner.leases += delta;
          owner.idleGeneration += 1;
          yield* scheduleIdleLocked(owner);
        }),
      ),
    failed: (owner) => withLock(terminalLocked(owner, true)),
  });

  const openOwner = (owner: ConnectionOwner, settings: McpSettings) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        owner.activity = yield* activity.begin({ operation: "connect", server: owner.server.id });
        yield* activity.update(owner.activity, { phase: "connecting" });
        const acquired = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              yield* withLock(executionServerLocked(owner.server.id));
              const token = yield* access(owner.server);
              yield* withLock(
                Effect.gen(function* () {
                  const current = yield* executionServerLocked(owner.server.id);
                  if (!owner.current || current.identity !== owner.server.identity)
                    return yield* stale();
                }),
              );
              owner.authorizationToken = token;
              return yield* Scope.provide(
                connector
                  .open(owner.server, settings, token)
                  .pipe(
                    Effect.tapError((error) =>
                      error.kind === "auth-required"
                        ? withLock(
                            rejectAuthLocked(owner, { credentialUsed: token !== undefined, error }),
                          )
                        : Effect.void,
                    ),
                  ),
                owner.scope,
              );
            }).pipe(
              Effect.mapError((error) => withAuthFailureReason(owner.server, error)),
              Effect.timeoutOrElse({
                duration: settings.connectTimeoutMs,
                orElse: () =>
                  Effect.fail(
                    boundaryError("timeout", "not-sent", "MCP connection deadline expired."),
                  ),
              }),
            ),
          ),
        );
        yield* withLock(
          Effect.gen(function* () {
            if (Exit.isSuccess(acquired)) {
              owner.connection = acquired.value;
              if (!owner.current) return;
              observationFailures.delete(owner.server.id);
              owner.state = "connected";
              if (acquired.value.remoteEvents)
                yield* Effect.forkIn(
                  Stream.runForEach(acquired.value.remoteEvents, (event) =>
                    (event.kind === "resource-updated"
                      ? resourceSubscriptions.awaitReady(owner, event.uri, event.subscription)
                      : Effect.void
                    ).pipe(
                      Effect.andThen(
                        withLock(
                          Effect.sync(() => {
                            if (
                              !owner.current ||
                              !owner.accepting ||
                              !options.isTrusted() ||
                              event.kind === "log" ||
                              (event.kind === "resource-updated" &&
                                !resourceSubscriptions.has(owner, event.uri, event.subscription))
                            )
                              return;
                            observations.publish(
                              owner.server.id,
                              event.kind === "resource-updated"
                                ? { kind: event.kind, uri: event.uri }
                                : event,
                            );
                          }),
                        ),
                      ),
                    ),
                  ),
                  owner.scope,
                );
              yield* activity.finish(owner.activity!, { status: "done" });
              changed();
              Deferred.doneUnsafe(owner.ready, Effect.succeed(acquired.value));
              yield* Effect.forkIn(
                Effect.interruptible(
                  Effect.exit(acquired.value.terminal).pipe(
                    Effect.flatMap((exit) => {
                      const error = Exit.findErrorOption(exit);
                      return withLock(
                        Effect.gen(function* () {
                          if (
                            owner.current &&
                            owners.get(owner.server.id) === owner &&
                            config.trusted &&
                            options.isTrusted() &&
                            config.servers[owner.server.id]?.identity === owner.server.identity &&
                            (yield* acquired.value.health).observation === "failed"
                          )
                            observationFailures.set(owner.server.id, owner.server.identity);
                          yield* terminalLocked(
                            owner,
                            error._tag === "Some" && error.value.kind === "cleanup",
                          );
                        }),
                      );
                    }),
                  ),
                ),
                owner.scope,
              );
              yield* scheduleIdleLocked(owner);
            } else {
              const error = Exit.findErrorOption(acquired);
              // A failed acquisition's boundary error preserves unconfirmed cleanup evidence.
              if (error._tag === "Some" && error.value instanceof McpBoundaryError) {
                owner.uncertain ||= error.value.kind === "cleanup";
                owner.failure =
                  error.value.reason === undefined
                    ? { kind: error.value.kind }
                    : { kind: error.value.kind, reason: error.value.reason };
              }
              Deferred.doneUnsafe(owner.ready, Effect.failCause(acquired.cause));
              // Preserve acquisition failures for its waiters. No ticket can dispatch without ready.
              yield* terminalLocked(owner);
            }
          }),
        );
      }),
    );

  const ownerLocked = (server: McpEffectiveServer) =>
    Effect.gen(function* () {
      const existing = owners.get(server.id);
      if (existing) {
        if (existing.state === "blocked")
          return yield* boundaryError(
            "cleanup",
            "not-sent",
            "MCP server cleanup is unconfirmed; replacement is blocked.",
          );
        if (!existing.current || !existing.accepting)
          return yield* boundaryError("busy", "not-sent", "MCP server cleanup is still running.");
        return existing;
      }
      const owner: ConnectionOwner = {
        id: `connection-${++sequence}`,
        server,
        scope: yield* Scope.fork(resources),
        ready: Deferred.makeUnsafe(),
        cleaned: Deferred.makeUnsafe(),
        shared: new Map(),
        state: "connecting",
        current: true,
        accepting: true,
        operations: 0,
        leases: 0,
        authorizationRevision: sequence,
        authorizationToken: undefined,
        idleGeneration: 0,
        uncertain: false,
      };
      yield* resourceSubscriptions.own(owner);
      owners.set(server.id, owner);
      changed();
      yield* Effect.forkIn(Effect.interruptible(openOwner(owner, config.settings)), owner.scope);
      return owner;
    });

  const snapshotLocked: Effect.Effect<McpConnectionStatus> = Effect.gen(function* () {
    const servers = yield* Effect.forEach(Object.values(config.servers), (server) =>
      Effect.gen(function* () {
        // Auth.status reads only observed state. Never resolve credentials from status.
        const observed = yield* auth.status(server);
        const connection = owners.get(server.id)?.connection;
        const health = connection === undefined ? undefined : yield* connection.health;
        let result: McpConnectionStatus["servers"][number] = {
          id: server.id,
          scope: server.scope,
          enabled: server.enabled,
          state: suspensions.has(server.id)
            ? ("blocked" as const)
            : (owners.get(server.id)?.state ?? ("disconnected" as const)),
          auth: observed.state,
          operationRevision,
          ...admission.snapshot(server.id),
          operations: admission.operations(server.id),
          blockedReason: owners.get(server.id)?.uncertain
            ? ("cleanup-unconfirmed" as const)
            : owners.get(server.id)?.state === "closing"
              ? ("cleanup-running" as const)
              : suspensions.has(server.id)
                ? suspensions.get(server.id)?.running
                  ? ("auth-running" as const)
                  : ("auth-suspended" as const)
                : undefined,
        };
        if (connection?.protocolVersion !== undefined)
          result = { ...result, protocolVersion: connection.protocolVersion };
        const observation =
          health?.observation ??
          (observationFailures.get(server.id) === server.identity ? "failed" : undefined);
        if (observation !== undefined) result = { ...result, observation };
        return result;
      }),
    );
    return {
      enabled: config.settings.enabled,
      trusted: config.trusted && options.isTrusted(),
      revision: config.revision,
      ...admission.snapshot(),
      servers,
    };
  });

  const revoke = (
    serverId?: string,
    evict = true,
    expected?: McpActionBinding,
  ): Effect.Effect<McpConnectionReceipt, McpBoundaryError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { ids, retired } = yield* withLock(
          Effect.gen(function* () {
            if (expected) yield* checkActionLocked(expected);
            const ids =
              serverId === undefined
                ? [...new Set([...Object.keys(config.servers), ...owners.keys()])]
                : [serverId];
            return { ids, retired: yield* revokeLocked(ids, evict) };
          }),
        );
        const outcomes = yield* restore(
          Effect.forEach(retired, (owner) => Deferred.await(owner.cleaned)),
        );
        return {
          servers: ids,
          cleanup: outcomes.includes("unconfirmed") ? "unconfirmed" : "confirmed",
        };
      }),
    );

  yield* store.subscribe((next) =>
    withLock(
      Effect.gen(function* () {
        const all = next.revision !== config.revision || !next.trusted || !next.settings.enabled;
        const affected = [
          ...new Set([...Object.keys(config.servers), ...Object.keys(next.servers)]),
        ].filter(
          (id) =>
            all ||
            config.servers[id]?.identity !== next.servers[id]?.identity ||
            config.servers[id]?.enabled !== next.servers[id]?.enabled,
        );
        config = next;
        observationFailures.clear();
        yield* revokeLocked(affected, true);
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* withLock(
        Effect.sync(() => {
          closed = true;
        }),
      );
      yield* revoke().pipe(Effect.catch(() => Effect.void));
    }),
  );

  return {
    observations,
    readEvents: (server: string, cursor?: string, limit?: number) =>
      withLock(
        Effect.gen(function* () {
          yield* serverLocked(server);
          const data = yield* observations.read(server, cursor, limit);
          const ingressDropped = yield* (
            owners.get(server)?.connection?.remoteEventDrops ?? Effect.succeed(0)
          );
          return { ...data, ingressDropped };
        }),
      ),
    resourceSubscriptions,
    withLock,
    admission,
    changed,
    checkActionLocked,
    checkAction: (expected: McpActionBinding) => withLock(checkActionLocked(expected)),
    subscribeChanges: (listener: () => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          changes.add(listener);
        }),
        () =>
          Effect.sync(() => {
            changes.delete(listener);
          }),
      ),
    ownerLocked,
    serverLocked,
    executionServerLocked,
    suspensions,
    revokeLocked,
    ownerCheckLocked,
    checkLocked,
    access,
    checkTokenLocked,
    rejectAuthLocked,
    scheduleIdleLocked,
    configLocked: () => config,
    retire,
    terminalLocked,
    acceptingLocked,
    // Read-only host projection. This neither grants tickets nor publishes trust changes.
    isAvailable: () => !closed && config.trusted && config.settings.enabled && options.isTrusted(),
    status: withLock(
      Effect.gen(function* () {
        yield* trustLocked;
        return yield* snapshotLocked;
      }),
    ),
    config: withLock(
      Effect.gen(function* () {
        yield* trustLocked;
        return config;
      }),
    ),
    requireServer: (id: string) => withLock(serverLocked(id)),
    revoke,
    subscribeRevocations: (listener: McpRevocationListener) =>
      Effect.acquireRelease(
        withLock(
          Effect.sync(() => {
            listeners.add(listener);
          }),
        ),
        () =>
          withLock(
            Effect.sync(() => {
              listeners.delete(listener);
            }),
          ),
      ),
  };
});

export type McpRegistry = Effect.Success<ReturnType<typeof makeRegistry>>;
