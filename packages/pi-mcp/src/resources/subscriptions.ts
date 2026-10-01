import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpConnection } from "../client/model.ts";
import type { ConnectionOwner } from "../connection/registry.ts";
import {
  MCP_RESOURCE_SUBSCRIPTION_LIMITS,
  type McpResourceSubscription,
} from "./subscription-model.ts";

interface Entry {
  readonly owner: ConnectionOwner;
  readonly uri: string;
  readonly identity: symbol;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<void, McpBoundaryError>;
  close: Effect.Effect<void, McpBoundaryError>;
  handle?: McpResourceSubscription;
  active: boolean;
  closing: boolean;
}
interface Hooks {
  readonly check: (owner: ConnectionOwner) => Effect.Effect<void, McpBoundaryError>;
  readonly lease: (owner: ConnectionOwner, delta: number) => Effect.Effect<void>;
  readonly failed: (owner: ConnectionOwner) => Effect.Effect<void>;
}
const gone = () =>
  boundaryError("stale", "unknown", "MCP resource subscription is no longer active.");

/** Explicit resource leases, separate from metadata subscriptions. No automatic re-listening. */
export const makeResourceSubscriptions = (hooks: Hooks) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const entries = new Map<string, Entry>();
    const owners = new WeakSet<ConnectionOwner>();
    const key = (owner: ConnectionOwner, uri: string) => `${owner.id}\n${uri}`;
    const closeEntry = (entry: Entry) => entry.close;
    const subscribe = (owner: ConnectionOwner, connection: McpConnection, uri: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(hooks.check(owner));
          if (!connection.capabilities.resourceSubscriptions)
            return yield* boundaryError(
              "unsupported",
              "not-sent",
              "MCP server does not support resource subscriptions.",
            );
          const acquired = yield* lock.withPermit(
            Effect.gen(function* () {
              if (!owners.has(owner)) return yield* gone();
              const existing = entries.get(key(owner, uri));
              if (existing) {
                if (existing.closing) return yield* gone();
                return { entry: existing, fresh: false };
              }
              if (
                entries.size >= MCP_RESOURCE_SUBSCRIPTION_LIMITS.session ||
                [...entries.values()].filter((entry) => entry.owner === owner).length >=
                  MCP_RESOURCE_SUBSCRIPTION_LIMITS.perOwner
              )
                return yield* boundaryError(
                  "busy",
                  "not-sent",
                  "MCP resource subscription limit reached.",
                );
              yield* hooks.check(owner);
              const scope = yield* Scope.fork(owner.scope);
              const entry: Entry = {
                owner,
                uri,
                identity: Symbol("MCP resource lease"),
                scope,
                ready: Deferred.makeUnsafe(),
                active: false,
                closing: false,
                close: Effect.void,
              };
              yield* hooks.lease(owner, 1);
              entries.set(key(owner, uri), entry);
              const cachedClose = yield* Effect.cached(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    entry.closing = true;
                    entry.active = false;
                    Deferred.doneUnsafe(entry.ready, Effect.fail(gone()));
                    yield* Scope.close(entry.scope, Exit.void);
                    const closed = entry.handle
                      ? yield* Effect.exit(entry.handle.close)
                      : Exit.void;
                    if (Exit.isFailure(closed) || (yield* connection.health).cleanupUnconfirmed) {
                      yield* hooks.failed(owner);
                      return yield* boundaryError(
                        "cleanup",
                        "unknown",
                        "MCP resource subscription cleanup is unconfirmed.",
                      );
                    }
                    yield* lock.withPermit(
                      Effect.sync(() => {
                        if (entries.get(key(owner, uri)) === entry) entries.delete(key(owner, uri));
                      }),
                    );
                    yield* hooks.lease(owner, -1);
                  }),
                ),
              );
              // Mask the cache's first-caller handoff too: caching an interrupted
              // start would make every later close replay incomplete cleanup.
              entry.close = Effect.uninterruptible(cachedClose);
              return { entry, fresh: true };
            }),
          );
          const { entry } = acquired;
          if (!acquired.fresh) {
            yield* restore(Deferred.await(entry.ready));
            yield* hooks.check(owner);
            if (!entry.active) return yield* gone();
            return { server: owner.server.id, uri, subscribed: true, existing: true };
          }
          const opening = yield* Effect.forkIn(
            Effect.gen(function* () {
              const handle = yield* connection.subscribeResource(uri, entry.identity);
              entry.handle = handle;
              yield* hooks.check(owner);
              if (entry.closing) return yield* gone();
              entry.active = true;
              yield* Deferred.succeed(entry.ready, undefined);
              return handle;
            }).pipe(Effect.provideService(Scope.Scope, entry.scope)),
            entry.scope,
          );
          const opened = yield* Effect.exit(restore(Fiber.join(opening)));
          if (Exit.isFailure(opened)) {
            yield* closeEntry(entry);
            return yield* Effect.failCause(opened.cause);
          }
          yield* Effect.forkIn(
            opened.value.closed.pipe(Effect.andThen(closeEntry(entry)), Effect.ignore),
            owner.scope,
          );
          yield* hooks.check(owner);
          return { server: owner.server.id, uri, subscribed: true, existing: false };
        }),
      );
    return {
      // Install before the registry publishes the owner. One finalizer visits only
      // currently owned entries; normal child-scope closure detaches its cleanup.
      own: (owner: ConnectionOwner) =>
        Effect.gen(function* () {
          owners.add(owner);
          yield* Scope.addFinalizer(
            owner.scope,
            Effect.gen(function* () {
              const selected = yield* lock.withPermit(
                Effect.sync(() => {
                  owners.delete(owner);
                  return [...entries.values()].filter((entry) => entry.owner === owner);
                }),
              );
              yield* Effect.forEach(selected, (entry) => closeEntry(entry).pipe(Effect.ignore), {
                discard: true,
              });
            }),
          );
        }),
      subscribe,
      // ACK-adjacent ingress may precede handle publication. Never wait with the
      // registry lock held: acquisition needs that lock for its authority check.
      awaitReady: (owner: ConnectionOwner, uri: string, identity?: symbol) =>
        Effect.suspend(() => {
          const entry = entries.get(key(owner, uri));
          return entry?.identity === identity && entry !== undefined
            ? Deferred.await(entry.ready).pipe(Effect.ignore)
            : Effect.void;
        }),
      has: (owner: ConnectionOwner, uri: string, identity?: symbol) => {
        const entry = entries.get(key(owner, uri));
        return (
          entry?.active === true &&
          !entry.closing &&
          entry.identity === identity &&
          entry.handle?.identity === identity &&
          owner.current &&
          owner.accepting
        );
      },
      status: (server: string) =>
        Effect.sync(() => ({
          server,
          subscriptions: [...entries.values()]
            .filter(
              (entry) =>
                entry.owner.server.id === server &&
                entry.owner.current &&
                entry.owner.accepting &&
                entry.active &&
                !entry.closing,
            )
            .map((entry) => ({ uri: entry.uri, state: "active" })),
        })),
      unsubscribe: (server: string, uri: string) =>
        Effect.gen(function* () {
          const selected = yield* lock.withPermit(
            Effect.sync(() =>
              [...entries.values()].filter(
                (entry) => entry.owner.server.id === server && entry.uri === uri,
              ),
            ),
          );
          yield* Effect.forEach(selected, closeEntry, { discard: true });
          return { server, uri, subscribed: false, existing: selected.length > 0 };
        }),
    };
  });
