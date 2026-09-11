import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { McpAuth } from "../auth/service.ts";
import { withAuthFailureReason } from "../auth/diagnostics.ts";
import { McpActivity } from "../activity/service.ts";
import { McpConnector } from "../boundary/sdk-connection.ts";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";
import type { McpConnection, McpRequest } from "../client/model.ts";
import { McpConfigStore } from "../config/store.ts";
import type { AdmissionTicket } from "./admission.ts";
import type { McpConnectionsContract, McpConnectionsOptions, McpOperation } from "./model.ts";
import { makeRegistry, type AuthSuspension, type ConnectionOwner } from "./registry.ts";

const makeService = Effect.fn("McpConnections.make")(function* (options: McpConnectionsOptions) {
  const registry = yield* makeRegistry(
    options,
    yield* McpConfigStore,
    yield* McpAuth,
    yield* McpConnector,
    yield* McpActivity,
  );
  const { withLock, admission } = registry;

  const release = (ticket: AdmissionTicket, owner: ConnectionOwner) =>
    withLock(
      Effect.gen(function* () {
        admission.release(ticket);
        owner.operations -= 1;
        if (!owner.accepting && owner.operations === 0) yield* registry.retire(owner);
        else yield* registry.scheduleIdleLocked(owner);
      }),
    );

  const withinDeadline = <A>(ticket: AdmissionTicket, work: Effect.Effect<A, McpBoundaryError>) =>
    Effect.gen(function* () {
      const remaining = ticket.deadline - (yield* Clock.currentTimeMillis);
      const timeout = () =>
        Effect.fail(boundaryError("timeout", ticket.outcome, "MCP operation deadline expired."));
      if (remaining <= 0) return yield* timeout();
      return yield* Effect.raceFirst(work, Deferred.await(ticket.revoked)).pipe(
        Effect.timeoutOrElse({ duration: remaining, orElse: timeout }),
      );
    });

  const runTicket = <A>(
    ticket: AdmissionTicket,
    owner: ConnectionOwner,
    work: Effect.Effect<A, McpBoundaryError>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const worker = yield* Effect.forkIn(Effect.interruptible(work), owner.scope);
        // The caller waits only on a join. Cancellation first removes publication authority,
        // then interrupts and joins the worker's I/O cleanup while retaining its capacity.
        return yield* restore(withinDeadline(ticket, Fiber.join(worker))).pipe(
          Effect.ensuring(
            withLock(Effect.sync(() => admission.cancel(ticket))).pipe(
              Effect.andThen(Fiber.interrupt(worker)),
            ),
          ),
        );
      }),
    );

  const operation = (
    ticket: AdmissionTicket,
    owner: ConnectionOwner,
    connection: McpConnection,
    revision: number,
    tool?: string,
  ): McpOperation => {
    const checkCurrent = withLock(registry.checkLocked(ticket, owner, tool, revision));
    const dispatchCheck = (input: McpRequest) =>
      withLock(
        Effect.gen(function* () {
          yield* registry.checkLocked(
            ticket,
            owner,
            input.action === "tools.call" ? input.tool : tool,
            revision,
          );
          yield* registry.acceptingLocked(owner);
        }),
      );
    const request = (input: McpRequest) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* dispatchCheck(input);
          const waiter = yield* withLock(Effect.sync(() => admission.enqueue(ticket)));
          return yield* restore(
            Effect.gen(function* () {
              yield* Deferred.await(waiter.ready);
              yield* dispatchCheck(input);
              const token = yield* registry
                .access(owner.server)
                .pipe(Effect.mapError((error) => withAuthFailureReason(owner.server, error)));
              yield* dispatchCheck(input);
              const definition = owner.server.definition;
              // Static HTTP headers are not managed tokens; clearing would revoke them.
              if (definition?.transport !== "http" || definition.auth.type !== "none")
                yield* connection.setToken(token);
              yield* dispatchCheck(input);
              const recordsOutcome =
                input.action === "tools.call" ||
                input.action === "resources.read" ||
                input.action === "prompts.get";
              if (recordsOutcome) ticket.outcome = "unknown";
              const reply = yield* connection.request(input).pipe(
                Effect.tapError((error) =>
                  withLock(
                    Effect.gen(function* () {
                      if (recordsOutcome) ticket.outcome = error.outcome;
                      if (error.kind === "auth-required")
                        yield* registry.rejectAuthLocked(owner, {
                          credentialUsed: token !== undefined,
                          error,
                        });
                      if (error.kind === "cleanup") yield* registry.terminalLocked(owner, true);
                    }),
                  ),
                ),
                Effect.mapError((error) => withAuthFailureReason(owner.server, error)),
              );
              yield* withLock(
                Effect.gen(function* () {
                  if (recordsOutcome) ticket.outcome = "completed";
                  if (reply.cleanupUnconfirmed) yield* registry.terminalLocked(owner, true);
                }),
              );
              yield* checkCurrent;
              return reply;
            }),
          ).pipe(Effect.ensuring(withLock(Effect.sync(() => admission.finish(waiter)))));
        }),
      );

    const shared: McpOperation["shared"] = <A>(
      key: string,
      use: (owned: McpOperation) => Effect.Effect<A, McpBoundaryError>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const completion = yield* withLock(
            Effect.gen(function* () {
              // A notification consumer can use this after the originating ticket ends.
              // Only its connection authority carries forward, never its deadline or ticket.
              yield* registry.ownerCheckLocked(owner);
              yield* registry.acceptingLocked(owner);
              const existing = owner.shared.get(key);
              if (existing) return existing;
              const fresh = admission.issueDependency(owner.server.id, now);
              if (fresh instanceof McpBoundaryError) return yield* fresh;
              owner.operations += 1;
              owner.idleGeneration += 1;
              const deferred = Deferred.makeUnsafe<unknown, McpBoundaryError>();
              owner.shared.set(key, deferred);
              const owned = operation(fresh, owner, connection, registry.configLocked().revision);
              const run = Effect.uninterruptibleMask((resume) =>
                Effect.gen(function* () {
                  const result = yield* Effect.exit(resume(runTicket(fresh, owner, use(owned))));
                  yield* withLock(
                    Effect.sync(() => {
                      if (owner.shared.get(key) === deferred) owner.shared.delete(key);
                      Deferred.doneUnsafe(
                        deferred,
                        Exit.isSuccess(result)
                          ? Effect.succeed(result.value)
                          : Effect.failCause(result.cause),
                      );
                    }),
                  );
                }),
              ).pipe(Effect.ensuring(release(fresh, owner)));
              yield* Effect.forkIn(Effect.interruptible(run), owner.scope);
              return deferred;
            }),
          );
          // SAFETY: each private key belongs to one metadata implementation and one result type.
          return (yield* restore(Deferred.await(completion))) as A;
        }),
      );

    return {
      binding: {
        server: owner.server.id,
        identity: owner.server.identity,
        configRevision: revision,
      },
      server: owner.server,
      owner: owner.id,
      capabilities: connection.capabilities,
      instructions: connection.instructions,
      changes: connection.changes,
      checkCurrent,
      commit: (publication) =>
        withLock(
          Effect.gen(function* () {
            yield* registry.checkLocked(ticket, owner, tool, revision);
            return yield* publication;
          }),
        ),
      request,
      shared,
      forkOwned: (effect) =>
        withLock(
          Effect.gen(function* () {
            yield* registry.checkLocked(ticket, owner, tool, revision);
            return yield* Effect.forkIn(Effect.interruptible(effect), owner.scope);
          }),
        ),
    };
  };

  const withOperation: McpConnectionsContract["withOperation"] = (serverId, intent, use) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const acquired = yield* withLock(
          Effect.gen(function* () {
            if (intent.expected) yield* registry.checkActionLocked(intent.expected);
            const server = yield* registry.executionServerLocked(serverId, intent.tool);
            const ticket = admission.issue(serverId, now);
            if (ticket instanceof McpBoundaryError) return yield* ticket;
            const owner = yield* registry
              .ownerLocked(server)
              .pipe(Effect.onError(() => Effect.sync(() => admission.release(ticket))));
            owner.operations += 1;
            owner.idleGeneration += 1;
            return { ticket, owner, revision: registry.configLocked().revision };
          }),
        );
        const { ticket, owner, revision } = acquired;
        const work = Effect.gen(function* () {
          const connection = yield* Deferred.await(owner.ready);
          const current = operation(ticket, owner, connection, revision, intent.tool);
          yield* current.checkCurrent;
          const value = yield* use(current);
          yield* current.checkCurrent;
          return value;
        });
        return yield* restore(runTicket(ticket, owner, work)).pipe(
          Effect.ensuring(release(ticket, owner)),
        );
      }),
    );

  const withAuth: McpConnectionsContract["withAuth"] = (serverId, use, expected) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const begin = withLock(
          Effect.gen(function* () {
            if (expected) yield* registry.checkActionLocked(expected);
            const server = yield* registry.serverLocked(serverId);
            const existing = registry.suspensions.get(serverId);
            if (existing?.running) return { waiting: true as const, gate: existing };
            const gate: AuthSuspension = {
              server,
              revision: registry.configLocked().revision,
              done: Deferred.makeUnsafe(),
              running: true,
            };
            registry.suspensions.set(serverId, gate);
            registry.changed();
            // Masked admission installs the gate and owned transport cleanup together.
            const retired = yield* registry.revokeLocked([serverId], true, "auth-transition");
            return { waiting: false as const, gate, retired };
          }),
        );
        let started = yield* begin;
        while (started.waiting) {
          yield* restore(Deferred.await(started.gate.done));
          started = yield* begin;
        }
        const { gate, retired } = started;
        const check = Effect.gen(function* () {
          const server = yield* registry.serverLocked(serverId);
          if (
            server.identity !== gate.server.identity ||
            registry.configLocked().revision !== gate.revision
          )
            return yield* boundaryError(
              "stale",
              "not-sent",
              "MCP authentication configuration changed.",
            );
        });
        const result = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              yield* Effect.forEach(retired, (owner) => Deferred.await(owner.cleaned));
              yield* withLock(check);
              return yield* use(gate.server);
            }),
          ),
        );
        // Callback finalizers have finished, even on interruption. Keep the suspension
        // through final authority revocation and all previously installed cleanup joins.
        const finalOwners = yield* withLock(
          registry.revokeLocked([serverId], true, "auth-transition"),
        );
        const outcomes = yield* Effect.forEach(finalOwners, (owner) =>
          Deferred.await(owner.cleaned),
        );
        const final = yield* withLock(
          Effect.gen(function* () {
            const checked = yield* Effect.exit(check);
            const outcome = Exit.isFailure(result)
              ? result
              : Exit.isFailure(checked)
                ? checked
                : outcomes.includes("unconfirmed")
                  ? Exit.fail(boundaryError("cleanup", "not-sent", "MCP cleanup is unconfirmed."))
                  : result;
            if (registry.suspensions.get(serverId) === gate) {
              gate.running = false;
              registry.changed();
              // A failed native handoff must not reopen execution. A later explicit auth
              // attempt can replace this settled gate instead of leaving an uncloseable wait.
              if (Exit.isSuccess(outcome)) registry.suspensions.delete(serverId);
              Deferred.doneUnsafe(gate.done, Effect.void);
            }
            return outcome;
          }),
        );
        return yield* Exit.isSuccess(final)
          ? Effect.succeed(final.value)
          : Effect.failCause(final.cause);
      }),
    );

  return {
    isAvailable: registry.isAvailable,
    config: registry.config,
    status: registry.status,
    requireServer: registry.requireServer,
    withAuth,
    withOperation,
    connect: (id, expected) =>
      withOperation(id, expected ? { expected } : {}, () => registry.status),
    disconnect: (id, expected) =>
      registry.requireServer(id).pipe(Effect.andThen(registry.revoke(id, false, expected))),
    revoke: (id) => registry.revoke(id).pipe(Effect.orDie),
    checkAction: registry.checkAction,
    subscribeChanges: registry.subscribeChanges,
    subscribeRevocations: registry.subscribeRevocations,
  } satisfies McpConnectionsContract;
});

export class McpConnections extends Context.Service<McpConnections, McpConnectionsContract>()(
  "pi-mcp/connection/service/McpConnections",
) {
  static readonly layer = (options: McpConnectionsOptions) =>
    Layer.effect(McpConnections, makeService(options));
}
