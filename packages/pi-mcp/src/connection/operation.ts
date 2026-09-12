import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";
import { withAuthFailureReason } from "../auth/diagnostics.ts";
import { terminalExchange } from "../boundary/sdk-elicitation.ts";
import type { McpExchange } from "../interaction/model.ts";
import type { McpConnection, McpRequest, McpDispatchOptions } from "../client/model.ts";
import type { AdmissionTicket } from "./admission.ts";
import type { McpOperation } from "./model.ts";
import type { McpRegistry, ConnectionOwner } from "./registry.ts";

export const makeOperationFactory = (
  registry: McpRegistry,
  release: (ticket: AdmissionTicket, owner: ConnectionOwner) => Effect.Effect<void>,
  runTicket: <A>(
    ticket: AdmissionTicket,
    owner: ConnectionOwner,
    work: Effect.Effect<A, McpBoundaryError>,
  ) => Effect.Effect<A, McpBoundaryError>,
) => {
  const { withLock, admission } = registry;
  const operation = (
    ticket: AdmissionTicket,
    owner: ConnectionOwner,
    connection: McpConnection,
    revision: number,
    tool?: string,
  ): McpOperation => {
    const authorizationRevision = owner.authorizationRevision;
    const checkAuthority = registry
      .checkLocked(ticket, owner, tool, revision)
      .pipe(
        Effect.andThen(
          Effect.suspend(() =>
            owner.authorizationRevision === authorizationRevision
              ? Effect.void
              : Effect.fail(
                  boundaryError("stale", ticket.outcome, "MCP credential authority changed."),
                ),
          ),
        ),
      );
    const checkCurrent = withLock(checkAuthority);
    const checkContinuation = Effect.gen(function* () {
      yield* withLock(checkAuthority.pipe(Effect.andThen(registry.acceptingLocked(owner))));
      const token = yield* registry
        .access(owner.server)
        .pipe(Effect.mapError((error) => withAuthFailureReason(owner.server, error)));
      yield* withLock(
        Effect.gen(function* () {
          yield* checkAuthority;
          yield* registry.checkTokenLocked(owner, token);
          yield* registry.acceptingLocked(owner);
        }),
      );
    });
    const dispatchCheck = (input: McpRequest) =>
      withLock(
        Effect.gen(function* () {
          yield* registry.checkLocked(
            ticket,
            owner,
            input.action === "tools.call" ? input.tool : tool,
            revision,
          );
          yield* checkAuthority;
          yield* registry.acceptingLocked(owner);
        }),
      );
    let incomplete = false;
    let leg = 0;
    let displayed = 0;
    const nativeExchange = (
      input: McpRequest,
      options?: McpDispatchOptions,
    ): Effect.Effect<McpExchange, McpBoundaryError> =>
      connection.exchange
        ? connection.exchange(input, options)
        : connection
            .request(input, options)
            .pipe(Effect.map((reply) => ({ kind: "complete" as const, reply })));
    const exchange = (
      input: McpRequest,
      options?: McpDispatchOptions,
    ): Effect.Effect<McpExchange, McpBoundaryError> =>
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
              yield* withLock(registry.checkTokenLocked(owner, token));
              yield* dispatchCheck(input);
              const definition = owner.server.definition;
              // Static HTTP headers are not managed tokens; clearing would revoke them.
              if (definition?.transport !== "http" || definition.auth.type !== "none")
                yield* connection.setToken(token);
              yield* dispatchCheck(input);
              const recordsOutcome =
                input.action === "tools.call" ||
                input.action === "resources.read" ||
                input.action === "prompts.get" ||
                input.action === "completion.complete";
              if (options?.logLevel && !connection.capabilities.requestLogging)
                return yield* boundaryError(
                  "unsupported",
                  "not-sent",
                  "MCP request-scoped logging is unavailable.",
                );
              let observing = true;
              const progressLeg = ++leg;
              if (recordsOutcome) ticket.outcome = "unknown";
              const reply = yield* nativeExchange(input, {
                ...options,
                onlog: (event) => {
                  if (
                    !options?.logLevel ||
                    !observing ||
                    !ticket.current ||
                    !owner.current ||
                    !owner.accepting ||
                    owner.authorizationRevision !== authorizationRevision ||
                    !registry.isAvailable()
                  )
                    return;
                  registry.observations.publish(owner.server.id, event);
                },
                onprogress: (progress) => {
                  if (
                    !observing ||
                    !ticket.current ||
                    !owner.current ||
                    !owner.accepting ||
                    owner.authorizationRevision !== authorizationRevision ||
                    !registry.isAvailable()
                  )
                    return;
                  const observed = registry.observations.publish(owner.server.id, {
                    ...progress,
                    kind: "progress",
                    operation: `${owner.id}:${ticket.id}`,
                    leg: progressLeg,
                  });
                  if (observed?.kind === "progress" && options?.onprogress && displayed++ < 64) {
                    try {
                      options.onprogress(observed);
                    } catch {
                      /* Display never changes execution certainty. */
                    }
                  }
                },
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    observing = false;
                  }),
                ),
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
                  if (reply.kind === "input-required") incomplete = true;
                  if (recordsOutcome)
                    ticket.outcome = reply.kind === "complete" ? "completed" : "unknown";
                  if (
                    reply.kind === "complete"
                      ? reply.reply.cleanupUnconfirmed
                      : reply.cleanupUnconfirmed
                  )
                    yield* registry.terminalLocked(owner, true);
                }),
              );
              yield* checkCurrent;
              return reply;
            }),
          ).pipe(Effect.ensuring(withLock(Effect.sync(() => admission.finish(waiter)))));
        }),
      ).pipe(
        Effect.mapError((error) =>
          incomplete && error.outcome === "not-sent"
            ? boundaryError(error.kind, "unknown", error.message, error.reason)
            : error,
        ),
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
        authorizationRevision,
      },
      server: owner.server,
      owner: owner.id,
      operationId: `${owner.id}:${ticket.id}`,
      capabilities: connection.capabilities,
      instructions: connection.instructions,
      changes: connection.changes,
      checkCurrent,
      checkContinuation,
      commit: (publication) =>
        withLock(
          Effect.gen(function* () {
            yield* checkAuthority;
            return yield* publication;
          }),
        ),
      subscribeResource: (uri) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* checkCurrent;
            const waiter = yield* withLock(Effect.sync(() => admission.enqueue(ticket)));
            return yield* restore(
              Effect.gen(function* () {
                yield* Deferred.await(waiter.ready);
                yield* checkCurrent;
                const token = yield* registry
                  .access(owner.server)
                  .pipe(Effect.mapError((error) => withAuthFailureReason(owner.server, error)));
                yield* withLock(registry.checkTokenLocked(owner, token));
                yield* checkCurrent;
                ticket.outcome = "unknown";
                const result = yield* registry.resourceSubscriptions
                  .subscribe(owner, connection, uri)
                  .pipe(
                    Effect.tapError((error) =>
                      withLock(
                        Effect.gen(function* () {
                          ticket.outcome = error.outcome;
                          if (error.kind === "auth-required")
                            yield* registry.rejectAuthLocked(owner, {
                              credentialUsed: token !== undefined,
                              error,
                            });
                        }),
                      ),
                    ),
                    Effect.mapError((error) => withAuthFailureReason(owner.server, error)),
                  );
                ticket.outcome = "completed";
                yield* checkCurrent;
                return result;
              }),
            ).pipe(Effect.ensuring(withLock(Effect.sync(() => admission.finish(waiter)))));
          }),
        ),
      exchange,
      request: (input, options) => exchange(input, options).pipe(Effect.flatMap(terminalExchange)),
      shared,
      forkOwned: (effect) =>
        withLock(
          Effect.gen(function* () {
            yield* checkAuthority;
            return yield* Effect.forkIn(Effect.interruptible(effect), owner.scope);
          }),
        ),
    };
  };

  return operation;
};
