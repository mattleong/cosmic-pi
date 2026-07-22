/* oxlint-disable typescript/no-this-alias -- Effect.gen uses an explicit stable class receiver. */
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  makeSynchronousIngress,
  type SynchronousIngress,
  type SynchronousIngressOfferResult,
} from "pi-cosmic-core";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import { snapshotData } from "../boundary/safe-data.ts";
import { isRecord } from "../shared/utils.ts";
import { AdvisorTrajectoryDetector } from "../review/trajectory.ts";
import {
  createAdvisorChildModelEffect,
  AdvisorModelError,
} from "./client.ts";
import {
  ADVISOR_TOOL_NAMES,
  createAdvisorToolsEffect,
  isPackageAdvisorTool,
  type AdvisorToolRunner,
} from "./tools.ts";
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
  isToolCallDelta,
  projectActiveToolNamesAtHostBoundary,
  stopSessionEffect,
  toModelError,
  unsafeToolNames,
} from "./session.ts";
import {
  AdvisorUsageWireSchema,
  DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS,
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
  type AdvisorRuntimeDependencies,
  type AdvisorRuntimeStartOptions,
} from "./types.ts";

export {
  MAX_ADVISOR_STATE_SUMMARY_CHARS,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  MAX_ADVISOR_CHECKPOINT_ID_CHARS,
  MAX_ADVISOR_TOOL_ROUNDS,
  MAX_ADVISOR_STREAM_CHARS,
  DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS,
  AdvisorCheckpointWireSchema,
  AdvisorRuntimeResetRequiredError,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorRuntimeStartOptions,
  type AdvisorRuntimeDriver,
  type AdvisorRuntimeDependencies,
} from "./types.ts";
export {
  parseAdvisorCheckpoint,
  parseAdvisorCheckpointEffect,
} from "./checkpoint-parse.ts";

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
                .acquireChildEffect(result.session, startEpoch, options.config.timeoutMs)
                .pipe(Effect.as(result));
            }),
          ),
        );
        if (startEpoch !== self.epoch)
          return yield* new AdvisorModelError({ message: "Advisor runtime start became stale." });
        yield* self.assertSessionSafeToolsEffect(result.session);
        if (result.session.sessionFile !== undefined)
          return yield* self.fatalSafetyFailureEffect(
            "Advisor child session unexpectedly has a persistent file.",
          );
        self.resetRequiredReason = undefined;
        self.pendingSeed = {
          seed: options.seed,
          ...(options.stateSummary === undefined ? {} : { stateSummary: options.stateSummary }),
          maxContextChars: options.config.maxContextChars,
        };
      });
      yield* initialize.pipe(
        Effect.timeout(Duration.millis(options.config.timeoutMs)),
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
      const child = yield* self.requireChildEffect();
      const session = child.session;
      child.releaseState.aborted = false;
      yield* self.assertSafeToolsEffect();
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
        Effect.andThen(self.awaitChildEventsEffect(checkpointEpoch)),
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
        Effect.andThen(self.awaitChildEventsEffect(checkpointEpoch)),
        Effect.onInterrupt(() => self.abortEffect()),
        Effect.timeout(Duration.millis(self.options?.config.timeoutMs ?? 30_000)),
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
      yield* self.assertSafeToolsEffect();
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
      const session = yield* self.requireSessionEffect();
      yield* self.assertSafeToolsEffect();
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
          const events = yield* makeSynchronousIngress<AdvisorChildEvent, never, never>({
            capacity: 128,
            overflow: "drop",
            handle: (event) => self.handleChildEventEffect(event),
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const finalizations = yield* makeSynchronousIngress<
            AdvisorFinalizationCompletion,
            never,
            never
          >({
            capacity: 1,
            overflow: "coalesce-latest",
            handle: (completion) => self.handleFinalizationCompletionEffect(completion),
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
          const unsubscribe = yield* Effect.try({
            try: () => session.subscribe((event) => self.observeChildEvent(handle, event)),
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
            awaitSessionAbortEffect(
              active.session,
              self.options?.config.timeoutMs ?? DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS,
            ),
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
  private requireChildEffect() {
    const self = this;
    return SynchronizedRef.get(self.activeChild).pipe(
      Effect.flatMap((active) => {
        if (self.resetRequiredReason)
          return Effect.fail(
            new AdvisorRuntimeResetRequiredError({ message: self.resetRequiredReason }),
          );
        return active
          ? Effect.succeed(active)
          : Effect.fail(new AdvisorModelError({ message: "Advisor runtime is not started." }));
      }),
    );
  }
  private requireSessionEffect() {
    return this.requireChildEffect().pipe(Effect.map((active) => active.session));
  }
  private assertSafeToolsEffect() {
    const self = this;
    return self
      .requireSessionEffect()
      .pipe(Effect.flatMap((session) => self.assertSessionSafeToolsEffect(session)));
  }
  private assertSessionSafeToolsEffect(session: AgentSession) {
    const self = this;
    return Effect.gen(function* () {
      const activeToolNames = yield* Effect.try({
        try: () => [...session.getActiveToolNames()],
        catch: toModelError("Advisor active tool metadata could not be read."),
      });
      for (const name of activeToolNames) {
        if (!(ADVISOR_TOOL_NAMES as readonly string[]).includes(name))
          return yield* self.failSafetyEffect(`Unsafe Advisor tool became active: ${name}`);
        const definition = yield* Effect.try({
          try: () => session.getToolDefinition(name),
          catch: toModelError("Advisor tool definition metadata could not be read."),
        });
        if (!isPackageAdvisorTool(definition))
          return yield* self.failSafetyEffect(`Advisor tool identity mismatch: ${name}`);
      }
    });
  }
  private failSafetyEffect(message: string) {
    return Effect.sync(() => isolateCallback(() => this.options?.onDiagnostic?.(message))).pipe(
      Effect.andThen(
        Effect.fail(
          new AdvisorModelError({ message: `Advisor runtime safety check failed: ${message}` }),
        ),
      ),
    );
  }
  private fatalSafetyFailureEffect(message: string) {
    return this.disposeEffect().pipe(
      Effect.ensuring(
        Effect.sync(() => isolateCallback(() => this.options?.onDiagnostic?.(message))),
      ),
      Effect.andThen(Effect.fail(new AdvisorModelError({ message: message }))),
    );
  }
  private observeChildEvent(child: ActiveAdvisorChild, event: AgentSessionEvent): void {
    try {
      if (child.epoch !== this.epoch || this.activeChildProjection !== child) return;
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          this.offerChildEvent(child, {
            epoch: child.epoch,
            type: "stream",
            streamKind: update.type === "thinking_delta" ? "thinking" : "text",
            text: update.delta,
          });
        } else if (isToolCallDelta(update)) {
          this.offerChildEvent(child, {
            epoch: child.epoch,
            type: "stream",
            streamKind: "tool",
            text: update.delta,
          });
        }
        return;
      }
      if (event.type === "turn_end") {
        if (event.toolResults.length > 0)
          this.offerChildEvent(child, {
            epoch: child.epoch,
            type: "tool-round",
          });
        return;
      }
      if (event.type !== "message_end") return;
      const messageSnapshot = snapshotData(event.message);
      if (!isRecord(messageSnapshot) || messageSnapshot.role !== "assistant") return;
      const stopReason =
        typeof messageSnapshot.stopReason === "string" ? messageSnapshot.stopReason : undefined;
      const active = this.activeCheckpoint;
      if (
        active &&
        active.epoch === child.epoch &&
        !active.finalizationQueued &&
        stopReason === "stop" &&
        child.session.isStreaming
      ) {
        active.finalizationQueued = true;
        try {
          // AgentSession requires followUp to be invoked before this streaming callback returns.
          // Its Promise completion is converted to plain bounded ingress and a typed Deferred.
          void child.session.followUp(active.finalPrompt).then(
            () => {
              child.finalizations.offer({ epoch: child.epoch, succeeded: true });
            },
            () => {
              child.finalizations.offer({ epoch: child.epoch, succeeded: false });
            },
          );
        } catch {
          child.finalizations.offer({ epoch: child.epoch, succeeded: false });
        }
      }
      this.offerChildEvent(child, {
        epoch: child.epoch,
        type: "message-end",
        ...(stopReason === undefined ? {} : { stopReason }),
        ...(typeof messageSnapshot.errorMessage === "string"
          ? { errorMessage: messageSnapshot.errorMessage }
          : {}),
        usage: snapshotData(messageSnapshot.usage),
      });
    } catch {
      this.invalidateForReprime("Advisor child event boundary failed.");
    }
  }
  private offerChildEvent(child: ActiveAdvisorChild, event: AdvisorChildEvent): void {
    child.pendingEvents++;
    const result: SynchronousIngressOfferResult = child.events.offer(event);
    if (result !== "accepted") {
      child.pendingEvents--;
      this.invalidateForReprime("Advisor child event ingress overflowed.");
    }
  }
  private awaitChildEventsEffect(epoch: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      const child = this.activeChildProjection;
      return !child || child.epoch !== epoch || child.pendingEvents === 0
        ? Effect.void
        : Effect.yieldNow.pipe(Effect.andThen(this.awaitChildEventsEffect(epoch)));
    });
  }
  private handleChildEventEffect(event: AdvisorChildEvent) {
    return Effect.sync(() => {
      const child = this.activeChildProjection;
      if (event.epoch !== this.epoch || !child || child.epoch !== event.epoch) return;
      if (event.type === "stream") {
        const text = event.text ?? "";
        this.recordStreamChars(text.length);
        if (event.streamKind === "thinking" || event.streamKind === "text") {
          const signal = this.childStreamDetector.push(event.streamKind, text);
          if (signal) this.invalidateForReprime(`Advisor child stream loop: ${signal.reason}.`);
        }
        return;
      }
      if (event.type === "tool-round") {
        this.toolRounds++;
        if (this.toolRounds > MAX_ADVISOR_TOOL_ROUNDS)
          this.invalidateForReprime("Advisor exceeded the read-only tool-round limit.");
        return;
      }
      if (event.stopReason === "aborted") this.lastStopError = "Advisor review was aborted.";
      if (event.stopReason === "error")
        this.lastStopError = event.errorMessage || "Advisor review failed.";
      const usage = Schema.decodeUnknownOption(AdvisorUsageWireSchema)(event.usage);
      if (Option.isNone(usage)) return;
      isolateCallback(() =>
        this.options?.onUsage?.({
          cacheReadTokens: usage.value.cacheRead ?? 0,
          cacheWriteTokens: usage.value.cacheWrite ?? 0,
          cost: usage.value.cost?.total ?? 0,
          inputTokens: usage.value.input ?? 0,
          outputTokens: usage.value.output ?? 0,
          totalTokens: usage.value.totalTokens ?? 0,
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const child = this.activeChildProjection;
          if (child?.epoch === event.epoch) child.pendingEvents--;
        }),
      ),
    );
  }
  private handleFinalizationCompletionEffect(completion: AdvisorFinalizationCompletion) {
    const active = this.activeCheckpoint;
    if (!active || active.epoch !== completion.epoch) return Effect.void;
    return completion.succeeded
      ? Deferred.succeed(active.finalization, undefined).pipe(Effect.asVoid)
      : Deferred.fail(
          active.finalization,
          new AdvisorModelError({ message: "Advisor checkpoint finalization failed." }),
        ).pipe(Effect.asVoid);
  }
  private recordStreamChars(chars: number) {
    this.streamedChars += chars;
    if (this.streamedChars > MAX_ADVISOR_STREAM_CHARS)
      this.invalidateForReprime("Advisor child stream exceeded the maximum response size.");
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

export interface AdvisorRuntimeServiceShape {
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

export const makeAdvisorControlMailbox = (handle: () => Effect.Effect<void>) =>
  makeSynchronousIngress<void, never, never>({
    capacity: 1,
    overflow: "coalesce-latest",
    handle,
  }).pipe(Effect.orDie);

export class AdvisorRuntimeService extends Context.Service<
  AdvisorRuntimeService,
  AdvisorRuntimeServiceShape
>()("pi-advisor/runtime/runtime/AdvisorRuntimeService") {}

export const advisorRuntimeServiceLayer = (
  toolRunner: AdvisorToolRunner,
  dependencies: AdvisorRuntimeDependencies = {},
) =>
  Layer.effect(
    AdvisorRuntimeService,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const platform = yield* Effect.context<AdvisorPlatform>();
        let handleControl: () => Effect.Effect<void> = () => Effect.void;
        const controlMailbox = yield* makeAdvisorControlMailbox(() => handleControl());
        const activeChild = yield* SynchronizedRef.make<ActiveAdvisorChild | undefined>(undefined);
        const lifecycleLock = yield* Semaphore.make(1);
        const runtime = new AdvisorRuntime(
          dependencies,
          toolRunner,
          scope,
          controlMailbox,
          activeChild,
          lifecycleLock,
        );
        handleControl = () => runtime.controlEffect();
        const provide = <A, E>(effect: Effect.Effect<A, E, AdvisorPlatform>) =>
          effect.pipe(Effect.provide(platform));
        return {
          runtime,
          service: AdvisorRuntimeService.of({
            activeToolNames: () => runtime.activeToolNames,
            start: (options) => provide(runtime.startEffect(options)),
            checkpoint: (request) => provide(runtime.checkpointEffect(request)),
            steer: (observations) => provide(runtime.steerEffect(observations)),
            reprime: (seed, stateSummary) => provide(runtime.reprimeEffect(seed, stateSummary)),
            abort: () => provide(runtime.abortEffect()),
            dispose: () => provide(runtime.disposeEffect()),
          }),
        };
      }),
      ({ runtime }) => runtime.disposeEffect(),
    ).pipe(Effect.map(({ service }) => service)),
  );

export class NoDiscoveryAdvisorResourceLoader implements ResourceLoader {
  private readonly extensionRuntime = createExtensionRuntime();
  private readonly systemPrompt: string;
  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }
  getExtensions(): LoadExtensionsResult {
    return { extensions: [], errors: [], runtime: this.extensionRuntime };
  }
  getSkills() {
    return { skills: [], diagnostics: [] };
  }
  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }
  getThemes() {
    return { themes: [], diagnostics: [] };
  }
  getAgentsFiles() {
    return { agentsFiles: [] };
  }
  getSystemPrompt() {
    return this.systemPrompt;
  }
  getAppendSystemPrompt(): string[] {
    return [];
  }
  extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {}
  reload(): Promise<void> {
    return Promise.resolve();
  }
}


export const _advisorRuntimeTest = {
  buildCheckpointPrompt,
};
