/* oxlint-disable typescript/no-this-alias -- Effect.gen uses an explicit stable class receiver. */
import {
  createAgentSession,
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
import { ADVISOR_OPERATION_TIMEOUT_MS, ADVISOR_RECENT_CONTEXT_CHARS } from "../config/options.ts";
import { AdvisorTrajectoryDetector } from "../review/trajectory.ts";
import { createAdvisorChildModelEffect, AdvisorModelError } from "./client.ts";
import { ADVISOR_TOOL_NAMES, createAdvisorToolsEffect, type AdvisorToolRunner } from "./tools.ts";
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
  type AdvisorCheckpointRequest,
  type AdvisorChildEvent,
  type AdvisorFinalizationCompletion,
  type AdvisorForcedDetach,
  type AdvisorRuntimeDependencies,
  type AdvisorRuntimeStartOptions,
} from "./types.ts";
import { NoDiscoveryAdvisorResourceLoader } from "./resource-loader.ts";
import { makeAdvisorSessionEvents } from "./session-events.ts";
import { makeAdvisorSessionSafety } from "./session-safety.ts";

export class AdvisorRuntime {
  private activeChildProjection: ActiveAdvisorChild | undefined;
  private epoch = 0;
  private options: AdvisorRuntimeStartOptions | undefined;
  private toolRounds = 0;
  private streamedChars = 0;
  private childStreamDetector = new AdvisorTrajectoryDetector();
  private resetRequiredReason: string | undefined;
  private lastStopError: string | undefined;
  private pendingSeed: { seed: string; stateSummary?: string; maxContextChars: number } | undefined;
  private activeCheckpoint: ActiveCheckpointFinalization | undefined;
  private readonly dependencies: AdvisorRuntimeDependencies;
  private readonly toolRunner: AdvisorToolRunner;
  private readonly resourceScope: Scope.Scope;
  private readonly controlMailbox: SynchronousIngress<void>;
  private readonly activeChild: SynchronizedRef.SynchronizedRef<ActiveAdvisorChild | undefined>;
  private readonly lifecycleLock: Semaphore.Semaphore;
  private readonly sessionEvents: ReturnType<typeof makeAdvisorSessionEvents>;
  private readonly sessionSafety: ReturnType<typeof makeAdvisorSessionSafety>;
  private pendingStartCleanup: Deferred.Deferred<void> | undefined;
  constructor(
    dependencies: AdvisorRuntimeDependencies,
    toolRunner: AdvisorToolRunner,
    resourceScope: Scope.Scope,
    controlMailbox: SynchronousIngress<void>,
    activeChild: SynchronizedRef.SynchronizedRef<ActiveAdvisorChild | undefined>,
    lifecycleLock: Semaphore.Semaphore,
  ) {
    this.dependencies = dependencies;
    this.toolRunner = toolRunner;
    this.resourceScope = resourceScope;
    this.controlMailbox = controlMailbox;
    this.activeChild = activeChild;
    this.lifecycleLock = lifecycleLock;
    this.sessionSafety = makeAdvisorSessionSafety({
      activeChild: this.activeChild,
      resetRequiredReason: () => this.resetRequiredReason,
      onDiagnostic: (message) => this.options?.onDiagnostic?.(message),
      dispose: () => this.disposeEffect(),
    });
    this.sessionEvents = makeAdvisorSessionEvents({
      epoch: () => this.epoch,
      activeChild: () => this.activeChildProjection,
      activeCheckpoint: () => this.activeCheckpoint,
      invalidateForReprime: (message) => this.invalidateForReprime(message),
      recordStream: (kind, text) => {
        this.streamedChars += text.length;
        if (this.streamedChars > MAX_ADVISOR_STREAM_CHARS)
          this.invalidateForReprime("Advisor child stream exceeded the maximum response size.");
        if (kind === "thinking" || kind === "text") {
          const signal = this.childStreamDetector.push(kind, text);
          if (signal) this.invalidateForReprime(`Advisor child stream loop: ${signal.reason}.`);
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
    const session = this.activeChildProjection?.session;
    return session ? projectActiveToolNamesAtHostBoundary(session) : [];
  }
  get childSession(): AgentSession | undefined {
    return this.activeChildProjection?.session;
  }
  startEffect(options: AdvisorRuntimeStartOptions) {
    const self = this;
    return Effect.gen(function* () {
      // Serialize detachment and bounded finalization so a replacement never overlaps an owned
      // child. Startup remains interruptible and uses the epoch token to reject stale concurrent
      // initializations.
      const admission = yield* self.lifecycleLock.withPermits(1)(
        Effect.gen(function* () {
          yield* self.awaitPendingStartCleanupEffect();
          const reserved = yield* SynchronizedRef.modify(self.activeChild, (current) => {
            const startEpoch = ++self.epoch;
            if (self.activeChildProjection === current) self.activeChildProjection = undefined;
            return [{ startEpoch, previous: current } as const, undefined];
          });
          self.pendingSeed = undefined;
          self.activeCheckpoint = undefined;
          if (reserved.previous) yield* Scope.close(reserved.previous.scope, Exit.void);
          return reserved;
        }),
      );
      const startEpoch = admission.startEpoch;
      if (startEpoch !== self.epoch)
        return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
      self.options = options;
      const initialize = Effect.gen(function* () {
        const child = self.dependencies.createChildModel
          ? yield* Effect.tryPromise({
              try: () => self.dependencies.createChildModel!(options.ctx, options.config),
              catch: toModelError("Advisor model initialization failed."),
            })
          : yield* createAdvisorChildModelEffect(options.ctx, options.config);
        if (startEpoch !== self.epoch)
          return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        const tools = self.dependencies.createTools
          ? yield* Effect.tryPromise({
              try: () => self.dependencies.createTools!(options.ctx.cwd),
              catch: toModelError("Advisor tools could not be created."),
            })
          : yield* createAdvisorToolsEffect(options.ctx.cwd, self.toolRunner);
        if (startEpoch !== self.epoch)
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
        self.pendingStartCleanup = startCleanup;
        const result = yield* Effect.uninterruptibleMask(() =>
          Effect.interruptible(
            createChildSessionEffect(
              () => (self.dependencies.createSession ?? createAgentSession)(createOptions),
              startCleanup,
            ),
          ).pipe(
            Effect.flatMap((result) => {
              if (startEpoch !== self.epoch)
                return disposeSessionNowEffect(result.session).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new AdvisorModelError({ message: "Advisor runtime start became stale." }),
                    ),
                  ),
                );
              return self
                .acquireChildEffect(result.session, startEpoch, ADVISOR_OPERATION_TIMEOUT_MS)
                .pipe(Effect.as(result));
            }),
          ),
        );
        if (startEpoch !== self.epoch)
          return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        yield* self.sessionSafety.assertSessionSafeToolsEffect(result.session);
        if (result.session.sessionFile !== undefined)
          return yield* self.sessionSafety.fatalSafetyFailureEffect(
            "Advisor child session unexpectedly has a persistent file.",
          );
        self.resetRequiredReason = undefined;
        self.pendingSeed = {
          seed: options.seed,
          ...(options.stateSummary === undefined ? {} : { stateSummary: options.stateSummary }),
          maxContextChars: ADVISOR_RECENT_CONTEXT_CHARS,
        };
      });
      yield* initialize.pipe(
        Effect.timeout(Duration.millis(ADVISOR_OPERATION_TIMEOUT_MS)),
        Effect.mapError((error) =>
          error instanceof AdvisorModelError
            ? error
            : new AdvisorModelError({ message: "Advisor child startup timed out." }),
        ),
        Effect.onExit((exit) =>
          exit._tag === "Failure" ? self.invalidateFailedStartEffect(startEpoch) : Effect.void,
        ),
        Effect.withSpan("pi-advisor.child.start"),
      );
    });
  }
  checkpointEffect(request: AdvisorCheckpointRequest) {
    const self = this;
    return Effect.gen(function* () {
      const child = yield* self.sessionSafety.requireChildEffect();
      const session = child.session;
      child.releaseState.aborted = false;
      yield* self.sessionSafety.assertSafeToolsEffect();
      const checkpointEpoch = self.epoch;
      self.toolRounds = 0;
      self.streamedChars = 0;
      self.childStreamDetector.reset();
      self.resetRequiredReason = undefined;
      self.lastStopError = undefined;
      const seed = self.pendingSeed;
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
      self.activeCheckpoint = active;
      const promptEffect = Effect.tryPromise({
        try: () => session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
        catch: toModelError("Advisor checkpoint failed."),
      }).pipe(
        Effect.raceFirst(
          Deferred.await(active.abortRequested).pipe(
            Effect.andThen(self.abortEffect()),
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
        Effect.andThen(self.sessionEvents.awaitChildEventsEffect(checkpointEpoch)),
        Effect.andThen(
          Effect.suspend(() =>
            active.finalizationQueued
              ? Deferred.await(active.finalization).pipe(
                  Effect.raceFirst(
                    Deferred.await(active.abortRequested).pipe(
                      Effect.andThen(self.abortEffect()),
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
        Effect.andThen(self.sessionEvents.awaitChildEventsEffect(checkpointEpoch)),
        Effect.onInterrupt(() => self.abortEffect()),
        Effect.timeout(Duration.millis(ADVISOR_OPERATION_TIMEOUT_MS)),
        Effect.mapError((error) => {
          if (self.resetRequiredReason)
            return new AdvisorRuntimeResetRequiredError({ message: self.resetRequiredReason });
          if (error instanceof AdvisorModelError) return error;
          self.invalidateForReprime("Advisor review timed out and requires a fresh context.");
          return new AdvisorRuntimeResetRequiredError({ message: "Advisor review timed out." });
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (self.activeCheckpoint === active) self.activeCheckpoint = undefined;
          }),
        ),
        Effect.withSpan("pi-advisor.child.checkpoint"),
      );
      if (self.resetRequiredReason) {
        const reason = self.resetRequiredReason;
        yield* self.abortEffect();
        return yield* new AdvisorRuntimeResetRequiredError({ message: reason });
      }
      if (checkpointEpoch !== self.epoch)
        return yield* new AdvisorRuntimeResetRequiredError({
          message:
            self.resetRequiredReason ?? "Advisor checkpoint became stale after runtime reset.",
        });
      if (self.lastStopError) return yield* new AdvisorModelError({ message: self.lastStopError });
      if (!active.finalizationQueued)
        return yield* new AdvisorModelError({
          message:
            "Advisor prompt settled before correlated checkpoint finalization could be queued.",
        });
      yield* self.sessionSafety.assertSafeToolsEffect();
      if (seed === self.pendingSeed) self.pendingSeed = undefined;
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
    const self = this;
    return Effect.gen(function* () {
      const session = yield* self.sessionSafety.requireSessionEffect();
      yield* self.sessionSafety.assertSafeToolsEffect();
      const steeringEpoch = self.epoch;
      if (!session.isStreaming || !self.activeCheckpoint) return false;
      yield* Effect.tryPromise({
        try: () => session.steer(buildObservationSteer(observations)),
        catch: toModelError("Advisor steering failed."),
      });
      if (steeringEpoch !== self.epoch)
        return yield* new AdvisorModelError({
          message: "Advisor observation delivery became stale.",
        });
      return true;
    });
  }
  reprimeEffect(seed: string, stateSummary?: string) {
    const options = this.options;
    return options
      ? this.startEffect({
          ...options,
          seed,
          ...(stateSummary === undefined ? {} : { stateSummary }),
        }).pipe(Effect.withSpan("pi-advisor.child.reprime"))
      : Effect.fail(new AdvisorModelError({ message: "Advisor runtime is not started." }));
  }
  private acquireChildEffect(session: AgentSession, startEpoch: number, abortTimeoutMs: number) {
    const self = this;
    return Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(self.resourceScope);
        const releaseState = { aborted: false };
        let committed = false;
        const close = Scope.close(scope, Exit.void);
        yield* Scope.addFinalizer(
          scope,
          Effect.suspend(() => stopSessionEffect(session, !releaseState.aborted, abortTimeoutMs)),
        );
        const acquire = Effect.gen(function* () {
          let childHandle: ActiveAdvisorChild | undefined;
          const events = yield* makeSynchronousIngress<AdvisorChildEvent, never, never>({
            capacity: 128,
            overflow: "drop",
            handle: (event) =>
              childHandle
                ? self.sessionEvents.handleChildEventEffect(childHandle, event)
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
              self.sessionEvents.handleFinalizationCompletionEffect(completion),
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
              session.subscribe((event) => self.sessionEvents.observeChildEvent(handle, event)),
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
          const installed = yield* SynchronizedRef.modifyEffect(self.activeChild, (current) =>
            Effect.sync(() => {
              if (startEpoch !== self.epoch || current !== undefined)
                return [false, current] as const;
              self.activeChildProjection = handle;
              committed = true;
              return [true, handle] as const;
            }),
          );
          if (!installed)
            return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        });
        yield* Effect.interruptible(acquire).pipe(
          Effect.onExit(() => (committed ? Effect.void : close)),
        );
      }),
    );
  }
  private awaitPendingStartCleanupEffect() {
    const self = this;
    const pending = self.pendingStartCleanup;
    if (!pending) return Effect.void;
    return Deferred.await(pending).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (self.pendingStartCleanup === pending) self.pendingStartCleanup = undefined;
        }),
      ),
    );
  }
  private invalidateFailedStartEffect(startEpoch: number) {
    const self = this;
    return self.lifecycleLock.withPermits(1)(
      Effect.gen(function* () {
        if (startEpoch !== self.epoch) return;
        const active = yield* SynchronizedRef.modify(self.activeChild, (current) => {
          self.epoch++;
          if (self.activeChildProjection === current) self.activeChildProjection = undefined;
          return [current, undefined] as const;
        });
        self.pendingSeed = undefined;
        self.activeCheckpoint = undefined;
        if (active) yield* Scope.close(active.scope, Exit.void);
      }),
    );
  }
  abortEffect() {
    const self = this;
    return self.lifecycleLock.withPermits(1)(
      Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          yield* Effect.interruptible(self.awaitPendingStartCleanupEffect());
          self.epoch++;
          const selected = yield* SynchronizedRef.modify<
            ActiveAdvisorChild | undefined,
            AdvisorAbortSelection
          >(self.activeChild, (active) => {
            if (!active) return [{ active: undefined }, active];
            if (active.releaseState.aborted) {
              active.epoch = self.epoch;
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
              self.forceDetachChildEffect(
                active,
                "Advisor child abort was interrupted and requires a fresh context.",
              ),
            ),
          );
          if (outcome === "settled") active.epoch = self.epoch;
          else
            yield* self.forceDetachChildEffect(
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
    const self = this;
    return Effect.gen(function* () {
      const result = yield* SynchronizedRef.modify<
        ActiveAdvisorChild | undefined,
        AdvisorForcedDetach
      >(self.activeChild, (current) => {
        if (current !== target) return [{ active: undefined, publishDiagnostic: false }, current];
        if (self.activeChildProjection === target) self.activeChildProjection = undefined;
        return [{ active: target, publishDiagnostic: self.markResetRequired(reason) }, undefined];
      });
      if (!result.active) return;
      if (result.publishDiagnostic) isolateCallback(() => self.options?.onDiagnostic?.(reason));
      self.pendingSeed = undefined;
      self.activeCheckpoint = undefined;
      yield* Scope.close(result.active.scope, Exit.void);
    });
  }
  private disposeChildEffect() {
    const self = this;
    return self.lifecycleLock.withPermits(1)(
      Effect.gen(function* () {
        yield* self.awaitPendingStartCleanupEffect();
        const active = yield* SynchronizedRef.modify(self.activeChild, (current) => {
          self.epoch++;
          if (self.activeChildProjection === current) self.activeChildProjection = undefined;
          return [current, undefined] as const;
        });
        self.pendingSeed = undefined;
        self.activeCheckpoint = undefined;
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
