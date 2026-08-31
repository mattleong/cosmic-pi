import {
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { makeSynchronousIngress, type SynchronousIngress } from "pi-cosmic-core";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import { ADVISOR_OPERATION_TIMEOUT_MS, ADVISOR_RECENT_CONTEXT_CHARS } from "../config/options.ts";
import { emptyAdvisorTrajectoryDetector, pushAdvisorTrajectory } from "../review/trajectory.ts";
import { AdvisorModelError } from "./client.ts";
import type { AdvisorChildFactoryContract } from "./child-factory.ts";
import { ADVISOR_TOOL_NAMES, type AdvisorToolRunner } from "./tools.ts";
import { parseAdvisorCheckpointEffect } from "./checkpoint-parse.ts";
import {
  buildCheckpointFinalizationPrompt,
  buildCheckpointPrompt,
  buildObservationSteer,
  buildTrustedSystemPrompt,
} from "./prompts.ts";
import {
  assistantTextAfterPromptEffect,
  awaitSessionAbortEffect,
  createChildSessionEffect,
  disposeSessionNowEffect,
  isolateCallback,
  projectActiveToolNamesAtHostBoundary,
  stopSessionEffect,
  toModelError,
  unsafeToolNames,
} from "./session.ts";
import {
  MAX_ADVISOR_STREAM_CHARS,
  MAX_ADVISOR_TOOL_ROUNDS,
  AdvisorRuntimeResetRequiredError,
  type ActiveAdvisorChild,
  type ActiveCheckpointFinalization,
  type AdvisorAbortSelection,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorChildEvent,
  type AdvisorFinalizationCompletion,
  type AdvisorForcedDetach,
  type AdvisorRuntimeStartOptions,
} from "./types.ts";
import { NoDiscoveryAdvisorResourceLoader } from "./resource-loader.ts";
import { makeAdvisorSessionEvents } from "./session-events.ts";
import { makeAdvisorSessionSafety } from "./session-safety.ts";

export interface AdvisorRuntimeOperations {
  readonly activeToolNames: () => readonly string[];
  readonly start: (options: AdvisorRuntimeStartOptions) => Effect.Effect<void, AdvisorModelError>;
  readonly checkpoint: (
    request: AdvisorCheckpointRequest,
  ) => Effect.Effect<AdvisorCheckpoint, AdvisorModelError>;
  readonly steer: (observations: string) => Effect.Effect<boolean, AdvisorModelError>;
  readonly reprime: (seed: string, stateSummary?: string) => Effect.Effect<void, AdvisorModelError>;
  readonly abort: () => Effect.Effect<void>;
  readonly dispose: () => Effect.Effect<void>;
}

export interface ManagedAdvisorRuntimeOperations {
  readonly operations: AdvisorRuntimeOperations;
  readonly dispose: Effect.Effect<void>;
}

export const makeAdvisorControlMailbox = (handle: () => Effect.Effect<void>) =>
  makeSynchronousIngress<void, never, never>({
    capacity: 1,
    overflow: "coalesce-latest",
    handle,
  }).pipe(Effect.orDie);

export class AdvisorRuntime {
  private epoch = 0;
  private options: AdvisorRuntimeStartOptions | undefined;
  private toolRounds = 0;
  private streamedChars = 0;
  private childStreamState = emptyAdvisorTrajectoryDetector();
  private resetRequiredReason: string | undefined;
  private lastStopError: string | undefined;
  private pendingSeed: { seed: string; stateSummary?: string; maxContextChars: number } | undefined;
  private activeCheckpoint: ActiveCheckpointFinalization | undefined;
  private readonly childFactory: AdvisorChildFactoryContract;
  private readonly toolRunner: AdvisorToolRunner;
  private readonly resourceScope: Scope.Scope;
  private readonly controlMailbox: SynchronousIngress<void>;
  private readonly activeChild: SynchronizedRef.SynchronizedRef<ActiveAdvisorChild | undefined>;
  private readonly lifecycleLock: Semaphore.Semaphore;
  private readonly sessionEvents: ReturnType<typeof makeAdvisorSessionEvents>;
  private readonly sessionSafety: ReturnType<typeof makeAdvisorSessionSafety>;
  private pendingStartCleanup: Deferred.Deferred<void> | undefined;
  constructor(
    childFactory: AdvisorChildFactoryContract,
    toolRunner: AdvisorToolRunner,
    resourceScope: Scope.Scope,
    controlMailbox: SynchronousIngress<void>,
    activeChild: SynchronizedRef.SynchronizedRef<ActiveAdvisorChild | undefined>,
    lifecycleLock: Semaphore.Semaphore,
  ) {
    this.childFactory = childFactory;
    this.toolRunner = toolRunner;
    this.resourceScope = resourceScope;
    this.controlMailbox = controlMailbox;
    this.activeChild = activeChild;
    this.lifecycleLock = lifecycleLock;
    this.sessionSafety = makeAdvisorSessionSafety({
      activeChild: this.activeChild,
      resetRequiredReason: () => this.resetRequiredReason,
      onDiagnostic: (message) => this.options?.onDiagnostic?.(message),
      dispose: () => this.disposeChildEffect(),
    });
    this.sessionEvents = makeAdvisorSessionEvents({
      epoch: () => this.epoch,
      activeChild: () => SynchronizedRef.getUnsafe(this.activeChild),
      activeCheckpoint: () => this.activeCheckpoint,
      invalidateForReprime: (message) => this.invalidateForReprime(message),
      recordStream: (kind, text) => {
        this.streamedChars += text.length;
        if (this.streamedChars > MAX_ADVISOR_STREAM_CHARS)
          this.invalidateForReprime("Advisor child stream exceeded the maximum response size.");
        if (kind === "thinking" || kind === "text") {
          const result = pushAdvisorTrajectory(this.childStreamState, kind, text);
          this.childStreamState = result.state;
          if (result.signal)
            this.invalidateForReprime(`Advisor child stream loop: ${result.signal.reason}.`);
        }
      },
      recordToolRound: () => {
        this.toolRounds++;
        if (this.toolRounds > MAX_ADVISOR_TOOL_ROUNDS)
          this.invalidateForReprime("Advisor exceeded the read-only tool-round limit.");
      },
      recordStopError: (message) => {
        this.lastStopError = message;
      },
      recordUsage: (usage) => this.options?.onUsage?.(usage),
    });
  }
  get activeToolNames(): readonly string[] {
    const session = SynchronizedRef.getUnsafe(this.activeChild)?.session;
    return session ? projectActiveToolNamesAtHostBoundary(session) : [];
  }
  get childSession(): AgentSession | undefined {
    return SynchronizedRef.getUnsafe(this.activeChild)?.session;
  }
  startEffect(options: AdvisorRuntimeStartOptions) {
    return Effect.gen({ self: this }, function* () {
      // Serialize detachment and bounded finalization so a replacement never overlaps an owned
      // child. Startup remains interruptible and uses the epoch token to reject stale concurrent
      // initializations.
      const admission = yield* this.lifecycleLock.withPermits(1)(
        Effect.gen({ self: this }, function* () {
          yield* this.awaitPendingStartCleanupEffect();
          const reserved = yield* SynchronizedRef.modify(this.activeChild, (current) => {
            const startEpoch = ++this.epoch;
            return [{ startEpoch, previous: current } as const, undefined];
          });
          this.pendingSeed = undefined;
          this.activeCheckpoint = undefined;
          if (reserved.previous) yield* Scope.close(reserved.previous.scope, Exit.void);
          return reserved;
        }),
      );
      const startEpoch = admission.startEpoch;
      if (startEpoch !== this.epoch)
        return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
      this.options = options;
      const initialize = Effect.gen({ self: this }, function* () {
        const child = yield* this.childFactory.createChildModel(options.ctx, options.config);
        if (startEpoch !== this.epoch)
          return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        const tools = yield* this.childFactory.createTools(options.ctx.cwd, this.toolRunner);
        if (startEpoch !== this.epoch)
          return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        const createOptions: CreateAgentSessionOptions = {
          cwd: options.ctx.cwd,
          modelRuntime: child.modelRuntime,
          model: child.model,
          thinkingLevel: child.thinkingLevel,
          resourceLoader: new NoDiscoveryAdvisorResourceLoader(
            buildTrustedSystemPrompt(options.instructions),
          ),
          sessionManager: SessionManager.inMemory(options.ctx.cwd),
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
          }),
          tools: [...ADVISOR_TOOL_NAMES],
          customTools: [...tools],
          excludeTools: unsafeToolNames(),
        };
        const startCleanup = yield* Deferred.make<void>();
        this.pendingStartCleanup = startCleanup;
        const result = yield* Effect.uninterruptibleMask(() =>
          Effect.interruptible(
            createChildSessionEffect(
              () => this.childFactory.createSession(createOptions),
              startCleanup,
            ),
          ).pipe(
            Effect.flatMap((result) => {
              if (startEpoch !== this.epoch)
                return disposeSessionNowEffect(result.session).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new AdvisorModelError({ message: "Advisor runtime start became stale." }),
                    ),
                  ),
                );
              return this.acquireChildEffect(
                result.session,
                startEpoch,
                ADVISOR_OPERATION_TIMEOUT_MS,
              ).pipe(Effect.as(result));
            }),
          ),
        );
        if (startEpoch !== this.epoch)
          return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        yield* this.sessionSafety.assertSessionSafeToolsEffect(result.session);
        if (result.session.sessionFile !== undefined)
          return yield* this.sessionSafety.fatalSafetyFailureEffect(
            "Advisor child session unexpectedly has a persistent file.",
          );
        this.resetRequiredReason = undefined;
        const basePendingSeed = {
          seed: options.seed,
          maxContextChars: ADVISOR_RECENT_CONTEXT_CHARS,
        };
        this.pendingSeed =
          options.stateSummary === undefined
            ? basePendingSeed
            : { ...basePendingSeed, stateSummary: options.stateSummary };
      });
      yield* initialize.pipe(
        Effect.timeout(Duration.millis(ADVISOR_OPERATION_TIMEOUT_MS)),
        Effect.mapError((error) =>
          error instanceof AdvisorModelError
            ? error
            : new AdvisorModelError({ message: "Advisor child startup timed out." }),
        ),
        Effect.onExit((exit) =>
          exit._tag === "Failure" ? this.invalidateFailedStartEffect(startEpoch) : Effect.void,
        ),
        Effect.withSpan("pi-advisor.child.start"),
      );
    });
  }
  checkpointEffect(request: AdvisorCheckpointRequest) {
    return Effect.gen({ self: this }, function* () {
      const child = yield* this.sessionSafety.requireChildEffect();
      const session = child.session;
      child.releaseState.aborted = false;
      yield* this.sessionSafety.assertSafeToolsEffect();
      const checkpointEpoch = this.epoch;
      this.toolRounds = 0;
      this.streamedChars = 0;
      this.childStreamState = emptyAdvisorTrajectoryDetector();
      this.resetRequiredReason = undefined;
      this.lastStopError = undefined;
      const seed = this.pendingSeed;
      const prompt = buildCheckpointPrompt(request, seed);
      const finalPrompt = buildCheckpointFinalizationPrompt(request);
      const abortRequested = yield* Deferred.make<void>();
      const finalization = yield* Deferred.make<void, AdvisorModelError>();
      const active: ActiveCheckpointFinalization = {
        epoch: checkpointEpoch,
        finalPrompt,
        abortRequested,
        finalization,
        finalizationQueued: false,
      };
      this.activeCheckpoint = active;
      const promptEffect = Effect.tryPromise({
        try: () => session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
        catch: toModelError("Advisor checkpoint failed."),
      }).pipe(
        Effect.raceFirst(
          Deferred.await(active.abortRequested).pipe(
            Effect.andThen(this.abortEffect()),
            Effect.andThen(
              Effect.fail(
                new AdvisorRuntimeResetRequiredError({
                  message: "Advisor checkpoint requires a fresh context.",
                }),
              ),
            ),
          ),
        ),
      );
      yield* promptEffect.pipe(
        Effect.andThen(this.sessionEvents.awaitChildEventsEffect(checkpointEpoch)),
        Effect.andThen(
          Effect.suspend(() =>
            active.finalizationQueued
              ? Deferred.await(active.finalization).pipe(
                  Effect.raceFirst(
                    Deferred.await(active.abortRequested).pipe(
                      Effect.andThen(this.abortEffect()),
                      Effect.andThen(
                        Effect.fail(
                          new AdvisorRuntimeResetRequiredError({
                            message: "Advisor checkpoint requires a fresh context.",
                          }),
                        ),
                      ),
                    ),
                  ),
                )
              : Effect.void,
          ),
        ),
        Effect.andThen(this.sessionEvents.awaitChildEventsEffect(checkpointEpoch)),
        Effect.onInterrupt(() => this.abortEffect()),
        Effect.timeout(Duration.millis(ADVISOR_OPERATION_TIMEOUT_MS)),
        Effect.mapError((error) => {
          if (this.resetRequiredReason)
            return new AdvisorRuntimeResetRequiredError({ message: this.resetRequiredReason });
          if (error instanceof AdvisorModelError) return error;
          this.invalidateForReprime("Advisor review timed out and requires a fresh context.");
          return new AdvisorRuntimeResetRequiredError({ message: "Advisor review timed out." });
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.activeCheckpoint === active) this.activeCheckpoint = undefined;
          }),
        ),
        Effect.withSpan("pi-advisor.child.checkpoint"),
      );
      if (this.resetRequiredReason) {
        const reason = this.resetRequiredReason;
        yield* this.abortEffect();
        return yield* new AdvisorRuntimeResetRequiredError({ message: reason });
      }
      if (checkpointEpoch !== this.epoch)
        return yield* new AdvisorRuntimeResetRequiredError({
          message:
            this.resetRequiredReason ?? "Advisor checkpoint became stale after runtime reset.",
        });
      if (this.lastStopError) return yield* new AdvisorModelError({ message: this.lastStopError });
      if (!active.finalizationQueued)
        return yield* new AdvisorModelError({
          message:
            "Advisor prompt settled before correlated checkpoint finalization could be queued.",
        });
      yield* this.sessionSafety.assertSafeToolsEffect();
      if (seed === this.pendingSeed) this.pendingSeed = undefined;
      const finalizedText = yield* assistantTextAfterPromptEffect(session.messages, finalPrompt);
      const checkpoint = yield* parseAdvisorCheckpointEffect(finalizedText);
      if (
        checkpoint.checkpointId !== request.checkpointId ||
        checkpoint.processedThrough !== request.processedThrough
      )
        return yield* new AdvisorModelError({
          message: "Advisor checkpoint correlation did not match the request.",
        });
      return checkpoint;
    });
  }
  steerEffect(observations: string) {
    return Effect.gen({ self: this }, function* () {
      const session = yield* this.sessionSafety.requireSessionEffect();
      yield* this.sessionSafety.assertSafeToolsEffect();
      const steeringEpoch = this.epoch;
      if (!session.isStreaming || !this.activeCheckpoint) return false;
      yield* Effect.tryPromise({
        try: () => session.steer(buildObservationSteer(observations)),
        catch: toModelError("Advisor steering failed."),
      });
      if (steeringEpoch !== this.epoch)
        return yield* new AdvisorModelError({
          message: "Advisor observation delivery became stale.",
        });
      return true;
    });
  }
  reprimeEffect(seed: string, stateSummary?: string) {
    const options = this.options;
    if (!options)
      return Effect.fail(new AdvisorModelError({ message: "Advisor runtime is not started." }));
    const baseOptions = { ...options, seed };
    const startOptions =
      stateSummary === undefined ? baseOptions : { ...baseOptions, stateSummary };
    return this.startEffect(startOptions).pipe(Effect.withSpan("pi-advisor.child.reprime"));
  }
  private acquireChildEffect(session: AgentSession, startEpoch: number, abortTimeoutMs: number) {
    return Effect.uninterruptibleMask(() =>
      Effect.gen({ self: this }, function* () {
        const scope = yield* Scope.fork(this.resourceScope);
        const releaseState = { aborted: false };
        let childHandle: ActiveAdvisorChild | undefined;
        const close = Scope.close(scope, Exit.void);
        yield* Scope.addFinalizer(
          scope,
          Effect.suspend(() => stopSessionEffect(session, !releaseState.aborted, abortTimeoutMs)),
        );
        const acquire = Effect.gen({ self: this }, function* () {
          const events = yield* makeSynchronousIngress<AdvisorChildEvent, never, never>({
            capacity: 128,
            overflow: "drop",
            handle: (event) =>
              childHandle
                ? this.sessionEvents.handleChildEventEffect(childHandle, event)
                : Effect.void,
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const finalizations = yield* makeSynchronousIngress<
            AdvisorFinalizationCompletion,
            never,
            never
          >({
            capacity: 1,
            overflow: "coalesce-latest",
            handle: (completion) =>
              this.sessionEvents.handleFinalizationCompletionEffect(completion),
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const handle: ActiveAdvisorChild = {
            epoch: startEpoch,
            session,
            scope,
            releaseState,
            pendingEvents: 0,
            events,
            finalizations,
          };
          childHandle = handle;
          const unsubscribe = yield* Effect.try({
            try: () =>
              session.subscribe((event) => this.sessionEvents.observeChildEvent(handle, event)),
            catch: () =>
              new AdvisorModelError({ message: "Advisor child event subscription failed." }),
          });
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              try {
                unsubscribe();
              } catch {
                /* subscription cleanup is isolated */
              }
            }),
          );
          const installed = yield* SynchronizedRef.modify(this.activeChild, (current) => {
            const canInstall = startEpoch === this.epoch && current === undefined;
            return [canInstall, canInstall ? handle : current] as const;
          });
          if (!installed)
            return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        });
        yield* Effect.interruptible(acquire).pipe(
          Effect.onExit(() =>
            SynchronizedRef.get(this.activeChild).pipe(
              Effect.flatMap((current) =>
                childHandle !== undefined && current === childHandle ? Effect.void : close,
              ),
            ),
          ),
        );
      }),
    );
  }
  private awaitPendingStartCleanupEffect() {
    const pending = this.pendingStartCleanup;
    if (!pending) return Effect.void;
    return Deferred.await(pending).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (this.pendingStartCleanup === pending) this.pendingStartCleanup = undefined;
        }),
      ),
    );
  }
  private invalidateFailedStartEffect(startEpoch: number) {
    return this.lifecycleLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (startEpoch !== this.epoch) return;
        const active = yield* SynchronizedRef.modify(this.activeChild, (current) => {
          this.epoch++;
          return [current, undefined] as const;
        });
        this.pendingSeed = undefined;
        this.activeCheckpoint = undefined;
        if (active) yield* Scope.close(active.scope, Exit.void);
      }),
    );
  }
  abortEffect() {
    return this.lifecycleLock.withPermits(1)(
      Effect.uninterruptibleMask(() =>
        Effect.gen({ self: this }, function* () {
          yield* Effect.interruptible(this.awaitPendingStartCleanupEffect());
          this.epoch++;
          const selected = yield* SynchronizedRef.modify<
            ActiveAdvisorChild | undefined,
            AdvisorAbortSelection
          >(this.activeChild, (active) => {
            if (!active) return [{ active: undefined }, active];
            if (active.releaseState.aborted) {
              active.epoch = this.epoch;
              return [{ active: undefined }, active];
            }
            active.releaseState.aborted = true;
            return [{ active }, active];
          });
          const active = selected.active;
          if (!active) return;
          const outcome = yield* Effect.interruptible(
            awaitSessionAbortEffect(active.session, ADVISOR_OPERATION_TIMEOUT_MS),
          ).pipe(
            Effect.onInterrupt(() =>
              this.forceDetachChildEffect(
                active,
                "Advisor child abort was interrupted and requires a fresh context.",
              ),
            ),
          );
          if (outcome === "settled") active.epoch = this.epoch;
          else
            yield* this.forceDetachChildEffect(
              active,
              outcome === "timed-out"
                ? "Advisor child abort timed out and requires a fresh context."
                : "Advisor child abort failed and requires a fresh context.",
            );
        }),
      ),
    );
  }
  private forceDetachChildEffect(target: ActiveAdvisorChild, reason: string) {
    return Effect.gen({ self: this }, function* () {
      const result = yield* SynchronizedRef.modify<
        ActiveAdvisorChild | undefined,
        AdvisorForcedDetach
      >(this.activeChild, (current) => {
        if (current !== target) return [{ active: undefined, publishDiagnostic: false }, current];
        return [{ active: target, publishDiagnostic: this.markResetRequired(reason) }, undefined];
      });
      if (!result.active) return;
      if (result.publishDiagnostic) isolateCallback(() => this.options?.onDiagnostic?.(reason));
      this.pendingSeed = undefined;
      this.activeCheckpoint = undefined;
      yield* Scope.close(result.active.scope, Exit.void);
    });
  }
  disposeChildEffect() {
    return this.lifecycleLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        yield* this.awaitPendingStartCleanupEffect();
        const active = yield* SynchronizedRef.modify(this.activeChild, (current) => {
          this.epoch++;
          return [current, undefined] as const;
        });
        this.pendingSeed = undefined;
        this.activeCheckpoint = undefined;
        if (active) yield* Scope.close(active.scope, Exit.void);
      }),
    );
  }
  disposeEffect() {
    return this.disposeChildEffect().pipe(
      Effect.andThen(this.controlMailbox.shutdown),
      Effect.andThen(this.controlMailbox.awaitShutdown),
    );
  }
  controlEffect() {
    const active = this.activeCheckpoint;
    return active
      ? Deferred.succeed(active.abortRequested, undefined).pipe(Effect.asVoid)
      : this.disposeChildEffect();
  }
  private invalidateForReprime(message: string) {
    if (!this.markResetRequired(message)) return;
    this.controlMailbox.offer(undefined);
    isolateCallback(() => this.options?.onDiagnostic?.(message));
  }
  private markResetRequired(message: string): boolean {
    if (this.resetRequiredReason) return false;
    this.resetRequiredReason = message;
    return true;
  }
}

/** Builds the plain Context-service implementation around the internal session state machine. */
export const makeAdvisorRuntimeOperations = Effect.fn("AdvisorRuntimeOperations.make")(function* (
  childFactory: AdvisorChildFactoryContract,
  toolRunner: AdvisorToolRunner,
) {
  const resourceScope = yield* Effect.scope;
  const platform = yield* Effect.context<AdvisorPlatform>();
  let runtime: AdvisorRuntime | undefined;
  const controlMailbox = yield* makeAdvisorControlMailbox(() =>
    runtime ? runtime.controlEffect().pipe(Effect.provide(platform)) : Effect.void,
  );
  const activeChild = yield* SynchronizedRef.make<ActiveAdvisorChild | undefined>(undefined);
  const lifecycleLock = yield* Semaphore.make(1);
  runtime = new AdvisorRuntime(
    childFactory,
    toolRunner,
    resourceScope,
    controlMailbox,
    activeChild,
    lifecycleLock,
  );
  const owned = runtime;
  const provide = <A, E>(effect: Effect.Effect<A, E, AdvisorPlatform>) =>
    effect.pipe(Effect.provide(platform));
  const operations: AdvisorRuntimeOperations = {
    activeToolNames: () => owned.activeToolNames,
    start: (options) => provide(owned.startEffect(options)),
    checkpoint: (request) => provide(owned.checkpointEffect(request)),
    steer: (observations) => provide(owned.steerEffect(observations)),
    reprime: (seed, stateSummary) => provide(owned.reprimeEffect(seed, stateSummary)),
    abort: () => provide(owned.abortEffect()),
    dispose: () => provide(owned.disposeChildEffect()),
  };
  return {
    operations,
    dispose: provide(owned.disposeEffect()),
  } satisfies ManagedAdvisorRuntimeOperations;
});
