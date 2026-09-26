import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { notifyListeners, sanitizeTerminalLine, scopedListener } from "pi-cosmic-core";
import { McpActivity } from "../activity/service.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpActionBinding } from "../connection/model.ts";
import { McpServerIdSchema } from "../config/schema.ts";
import { McpExecution } from "../tools/service.ts";
import type { McpAuthStatus, McpLoginUi } from "./model.ts";
import {
  authActivityPhase,
  authCanReopen,
  authPhaseTerminal,
  type McpAuthProgress,
  type McpAuthProgressEvent,
} from "./progress.ts";

/** Private user capability. Never put this object on an event bus or gateway reply. */
export interface McpAuthAttempt {
  readonly snapshot: () => McpAuthProgress;
  readonly now: () => number;
  readonly cancel: Effect.Effect<void>;
  readonly reopen: Effect.Effect<void, McpBoundaryError>;
  readonly subscribe: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
}
export interface McpAuthFlowContract {
  readonly subscribe: (
    listener: (progress: McpAuthProgress) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly run: (
    server: string,
    ui: McpLoginUi,
    present?: (attempt: McpAuthAttempt) => Effect.Effect<void, McpBoundaryError>,
    expected?: McpActionBinding,
  ) => Effect.Effect<McpAuthStatus, McpBoundaryError>;
}
const cancelled = () => boundaryError("cancelled", "not-sent", "OAuth login was cancelled.");
const stale = () =>
  boundaryError("stale", "not-sent", "This sign-in action is no longer available.");
const finalizationFailed = () =>
  boundaryError(
    "cleanup",
    "not-sent",
    "Credentials were saved but sign-in finalization failed.",
    "oauth-finalization-failed",
  );

export const makeMcpAuthFlow = Effect.gen(function* () {
  const execution = yield* McpExecution;
  const activity = yield* McpActivity;
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const admission = yield* Semaphore.make(1);
  const counter = yield* Ref.make(0);
  const listeners = new Set<(progress: McpAuthProgress) => void>();
  const notify = (value: McpAuthProgress) => notifyListeners(listeners, value);
  const subscribe: McpAuthFlowContract["subscribe"] = (listener) =>
    scopedListener(listeners, listener);
  const run: McpAuthFlowContract["run"] = (server, ui, present, expected) =>
    Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!Schema.is(McpServerIdSchema)(server))
            return yield* boundaryError("invalid-input", "not-sent", "Invalid MCP server ID.");
          const activityOwner = yield* activity.begin({ operation: "auth", server });
          yield* activity.update(activityOwner, { phase: "waiting-for-fence" });
          const browserAdmission = yield* Semaphore.make(1);
          const attemptId = yield* Ref.updateAndGet(counter, (n) => n + 1);
          const startedAt = yield* Clock.currentTimeMillis;
          const progress = yield* Ref.make<McpAuthProgress>(
            Object.freeze({
              attemptId,
              server: sanitizeTerminalLine(server).slice(0, 256),
              mode: ui.mode,
              phase: "waiting-fence",
              startedAt,
              updatedAt: startedAt,
              canReopen: false,
              credentialsSaved: false,
              mutation: "idle",
            }),
          );
          const stop = yield* Deferred.make<void>();
          const settled = yield* Deferred.make<void>();
          let handoff:
            | {
                readonly url: string;
                readonly deadline: number;
                readonly revoked: Deferred.Deferred<void>;
                active: boolean;
              }
            | undefined;
          const update = (change: (previous: McpAuthProgress) => McpAuthProgress) =>
            Ref.updateAndGet(progress, (previous) => Object.freeze(change(previous))).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  if (Ref.getUnsafe(counter) === attemptId) notify(value);
                }),
              ),
              Effect.tap((value) => {
                const phase = authActivityPhase(value.phase);
                if (phase !== undefined) return activity.update(activityOwner, { phase });
                const outcome: Parameters<typeof activity.finish>[1] = {
                  status:
                    value.phase === "succeeded"
                      ? "done"
                      : value.phase === "cancelled" && value.reason === undefined
                        ? "cancelled"
                        : "failed",
                };
                if (value.failureKind !== undefined)
                  Object.assign(outcome, { kind: value.failureKind });
                if (value.reason !== undefined) Object.assign(outcome, { reason: value.reason });
                return activity.finish(activityOwner, outcome);
              }),
              Effect.uninterruptible,
            );
          const emit = (event: McpAuthProgressEvent) =>
            Effect.gen(function* () {
              if (authPhaseTerminal((yield* Ref.get(progress)).phase)) return;
              const now = yield* Clock.currentTimeMillis;
              yield* update((previous) => {
                if (authPhaseTerminal(previous.phase)) return previous;
                if (previous.phase === "cancelling")
                  return {
                    ...previous,
                    mutation: event.mutation ?? previous.mutation,
                    credentialsSaved: event.credentialsSaved ?? previous.credentialsSaved,
                    updatedAt: now,
                  };
                const next: McpAuthProgress = {
                  attemptId,
                  server: previous.server,
                  mode: ui.mode,
                  phase: event.phase,
                  startedAt,
                  updatedAt: now,
                  canReopen:
                    handoff?.active === true && ui.mode === "local" && now < handoff.deadline,
                  credentialsSaved: event.credentialsSaved ?? previous.credentialsSaved,
                  mutation: event.mutation ?? previous.mutation,
                };
                if (event.deadline !== undefined) Object.assign(next, { deadline: event.deadline });
                if (event.reason !== undefined) Object.assign(next, { reason: event.reason });
                return next;
              });
            });
          const revokeHandoff = Effect.sync(() => {
            if (handoff) {
              handoff.active = false;
              Deferred.doneUnsafe(handoff.revoked, Effect.void);
              handoff = undefined;
            }
          });
          const requestCancel = Effect.gen(function* () {
            if (authPhaseTerminal((yield* Ref.get(progress)).phase)) return;
            yield* revokeHandoff;
            yield* emit({ phase: "cancelling" });
            yield* Deferred.succeed(stop, undefined);
          });
          const reopen = Effect.gen(function* () {
            const owned = handoff;
            const value = yield* Ref.get(progress);
            if (!owned?.active || !authCanReopen(value, yield* Clock.currentTimeMillis))
              return yield* stale();
            yield* emit({ phase: "opening-browser", deadline: owned.deadline });
            const mayOpen = () =>
              owned.active &&
              authCanReopen(Ref.getUnsafe(progress), clock.currentTimeMillisUnsafe());
            const opened = Effect.suspend(() =>
              mayOpen() ? ui.openBrowser(owned.url, mayOpen) : Effect.fail(stale()),
            ).pipe(
              Effect.raceFirst(
                Deferred.await(owned.revoked).pipe(Effect.andThen(Effect.fail(stale()))),
              ),
              Effect.timeoutOrElse({
                duration: Math.max(1, owned.deadline - (yield* Clock.currentTimeMillis)),
                orElse: () => Effect.fail(stale()),
              }),
            );
            yield* opened.pipe(
              Effect.tapError((error) =>
                owned.active && error.reason === "oauth-browser-open-failed"
                  ? emit({
                      phase: "awaiting-callback",
                      deadline: owned.deadline,
                      reason: "oauth-browser-open-failed",
                    })
                  : Effect.void,
              ),
            );
            if (!owned.active) return;
            yield* emit({ phase: "awaiting-callback", deadline: owned.deadline });
          }).pipe(
            browserAdmission.withPermitsIfAvailable(1),
            Effect.flatMap((opened) =>
              Option.isSome(opened)
                ? Effect.void
                : Effect.fail(
                    boundaryError("busy", "not-sent", "A browser-open action is already active."),
                  ),
            ),
          );
          const waitForCallback: NonNullable<McpLoginUi["waitForCallback"]> = (
            url,
            deadline,
            receive,
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const revoked = yield* Deferred.make<void>();
                handoff = { url, deadline, revoked, active: true };
                yield* emit({ phase: "awaiting-callback", deadline });
                // Receive concurrently so callback consumption revokes reopen even while the
                // operating system is still completing a browser-open request.
                const response = yield* receive.pipe(
                  Effect.ensuring(revokeHandoff),
                  Effect.forkScoped,
                );
                const openIfAvailable = reopen.pipe(
                  Effect.catchIf(
                    (error) =>
                      error.reason === "oauth-browser-open-failed" || error.kind === "stale",
                    () => Effect.void,
                  ),
                );
                if (ui.mode === "local") yield* openIfAvailable;
                const nextAction = ui.nextAction;
                if (ui.mode === "local" && nextAction) {
                  const actions = Effect.gen(function* () {
                    if (!handoff?.active) return yield* Effect.never;
                    const action = yield* nextAction(
                      deadline,
                      Ref.getUnsafe(progress).reason === "oauth-browser-open-failed",
                    );
                    if (action === "cancel") {
                      yield* requestCancel;
                      return yield* Effect.never;
                    }
                    yield* openIfAvailable;
                  }).pipe(Effect.forever);
                  return yield* Effect.raceFirst(Fiber.join(response), actions);
                }
                return yield* Fiber.join(response);
              }),
            ).pipe(Effect.ensuring(revokeHandoff));
          const attempt: McpAuthAttempt = {
            snapshot: () => Ref.getUnsafe(progress),
            now: () => clock.currentTimeMillisUnsafe(),
            cancel: requestCancel.pipe(Effect.andThen(Deferred.await(settled))),
            reopen,
            subscribe: (listener) => subscribe(() => listener()),
          };
          yield* Effect.sync(() => notify(Ref.getUnsafe(progress)));
          const ownedUi: McpLoginUi = { ...ui, progress: emit, waitForCallback };
          const work = execution.login(server, ownedUi, expected).pipe(
            Effect.raceFirst(Deferred.await(stop).pipe(Effect.andThen(Effect.fail(cancelled())))),
            Effect.mapError((error) => {
              const value = Ref.getUnsafe(progress);
              if (value.mutation !== "idle")
                return boundaryError(
                  error.kind,
                  error.outcome,
                  "Credential mutation remains unresolved.",
                  "oauth-mutation-unresolved",
                );
              return value.credentialsSaved ? finalizationFailed() : error;
            }),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* revokeHandoff;
                const now = yield* Clock.currentTimeMillis;
                const failure = Exit.isFailure(exit)
                  ? Cause.findErrorOption(exit.cause)
                  : Option.none<McpBoundaryError>();
                const error = Option.getOrUndefined(failure);
                const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
                yield* update((previous) => {
                  const phase = Exit.isSuccess(exit)
                    ? "succeeded"
                    : previous.credentialsSaved
                      ? "failed"
                      : interrupted ||
                          previous.phase === "cancelling" ||
                          error?.kind === "cancelled"
                        ? "cancelled"
                        : "failed";
                  const next: McpAuthProgress = {
                    attemptId,
                    server: previous.server,
                    mode: ui.mode,
                    phase,
                    startedAt,
                    updatedAt: now,
                    canReopen: false,
                    credentialsSaved: previous.credentialsSaved,
                    mutation: previous.mutation,
                  };
                  if (error) Object.assign(next, { failureKind: error.kind });
                  const reason =
                    previous.mutation !== "idle"
                      ? "oauth-mutation-unresolved"
                      : previous.credentialsSaved && phase !== "succeeded"
                        ? "oauth-finalization-failed"
                        : error?.reason;
                  if (reason) Object.assign(next, { reason });
                  return next;
                });
                yield* Deferred.succeed(settled, undefined);
              }),
            ),
          );
          // Session ownership prevents a cancelled waiter from abandoning listener or fence cleanup.
          const worker = yield* Effect.forkIn(Effect.interruptible(work), scope);
          if (present)
            yield* Effect.forkScoped(
              present(attempt).pipe(
                Effect.onExit(() => requestCancel),
                Effect.ignore,
                Effect.interruptible,
              ),
            );
          return yield* restore(Fiber.join(worker)).pipe(
            Effect.ensuring(requestCancel.pipe(Effect.andThen(Deferred.await(settled)))),
          );
        }),
      ),
    ).pipe(
      admission.withPermitsIfAvailable(1),
      Effect.flatMap((result) =>
        Effect.fromOption(result).pipe(
          Effect.mapError(() =>
            boundaryError(
              "busy",
              "not-sent",
              "A sign-in attempt is already active. Inspect the active attempt.",
            ),
          ),
        ),
      ),
    );
  return { run, subscribe } satisfies McpAuthFlowContract;
});
export class McpAuthFlow extends Context.Service<McpAuthFlow, McpAuthFlowContract>()(
  "pi-mcp/auth/flow/McpAuthFlow",
) {
  static readonly layer = Layer.effect(this, makeMcpAuthFlow);
}
