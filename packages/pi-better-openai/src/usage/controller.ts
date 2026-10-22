import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import {
  AgentDirectory,
  createSubscriptionRefresh,
  failureMessage,
  frozenProjection,
  invokeHostCallback,
  JsonHttpClient,
  notifyAtHostBoundary,
  recoverRefreshFailure,
  sanitizeDiagnosticError,
  type RefreshRequest,
} from "pi-cosmic-core";
import { getCodexCredentials } from "../auth/codex-auth.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { OpenAIConfigService } from "../config/store.ts";
import {
  formatUsageDetails,
  formatUsageSnapshot,
  requestCodexUsageWithCredentials,
  type UsageSnapshot,
} from "./format.ts";
import {
  HIDDEN_USAGE_STATUS_TEXT,
  initialProjection,
  isOpenAISubscriptionModel,
  synchronizedProjection,
  usageConfigChanged,
  withUsageEligibility,
  type OpenAIProjection,
  type UsageProjectionBase,
} from "./projection.ts";

const SPAN_PREFIX = "pi-better-openai.usage";
const LOG_LABEL = "Better OpenAI";

export interface UsageControllerConfig {
  readonly usage: {
    readonly refreshIntervalMs: number;
    readonly showOnlyOnSubscriptionModels: boolean;
  };
}

export type UsageFetchOutcome<Snapshot, Patch> = Data.TaggedEnum<{
  Missing: Record<never, never>;
  Failure: { readonly message: string; readonly patch?: Patch };
  Success: { readonly snapshot: Snapshot; readonly patch: Patch };
}>;

interface UsageFetchOutcomeDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: UsageFetchOutcome<this["A"], this["B"]>;
}

export const UsageFetchOutcome = Data.taggedEnum<UsageFetchOutcomeDefinition>();

const hostHasUi = (ctx: ExtensionContext): boolean => invokeHostCallback(() => ctx.hasUI, true);
const hostModelKey = (ctx: ExtensionContext): string =>
  invokeHostCallback(() => {
    const model = ctx.model;
    return `${model?.provider ?? "none"}/${model?.id ?? "none"}`;
  }, "unavailable");

type RefreshValue<Snapshot, Patch> = Data.TaggedEnum<{
  Skipped: Record<never, never>;
  Disabled: { readonly notify: boolean };
  Hidden: { readonly notify: boolean };
  Fetched: {
    readonly outcome: UsageFetchOutcome<Snapshot, Patch>;
    readonly notify: boolean;
    readonly fetchedAt: number;
  };
}>;

interface RefreshValueDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: RefreshValue<this["A"], this["B"]>;
}

const RefreshValue = Data.taggedEnum<RefreshValueDefinition>();

export interface UsageRefreshControllerOptions<
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
> {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly projection: MutableRef.MutableRef<P>;
  readonly onChange: () => void;
  readonly canPublish?: (() => boolean) | undefined;
  readonly backgroundEnabled?: (() => boolean) | undefined;
  readonly initialConfig: Resolved;
  readonly initialProjection: () => P;
  readonly hiddenStatusText: string;
  readonly missingCredentialsMessage: string;
  readonly clearAuthPatch: Partial<P>;
  readonly eligibility: (
    ctx: ExtensionContext,
    cfg: Resolved,
  ) => Effect.Effect<boolean, never, JsonHttpClient>;
  readonly synchronizeState?: (
    current: P,
    ctx: ExtensionContext,
    clearUsage: boolean,
  ) => Effect.Effect<P, never, JsonHttpClient>;
  readonly fetchOutcome: (args: {
    readonly ctx: ExtensionContext;
  }) => Effect.Effect<UsageFetchOutcome<Snapshot, Partial<P>>, never, JsonHttpClient>;
  readonly formatStatusLine: (snapshot: Snapshot, cfg: Resolved, fetchedAt: number) => string;
  readonly formatStatusText: (snapshot: Snapshot, fetchedAt: number) => string;
}

interface UsageRefreshController<
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
> {
  readonly refresh: (request?: RefreshRequest) => Effect.Effect<void>;
  readonly startPolling: () => Effect.Effect<void, never, Scope.Scope>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly getState: Effect.Effect<P>;
  readonly updateState: (f: (current: P) => P) => Effect.Effect<P>;
  readonly configure: (
    config: Resolved,
    options?: { readonly invalidate?: boolean },
  ) => Effect.Effect<void>;
}

const mergeProjection = <Resolved, Snapshot, P extends UsageProjectionBase<Resolved, Snapshot>>(
  current: P,
  base: Partial<UsageProjectionBase<Resolved, Snapshot>>,
  patch?: Partial<P>,
): P => ({ ...current, ...base, ...patch });

export const makeUsageRefreshController = <
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
>(
  options: UsageRefreshControllerOptions<P, Resolved, Snapshot>,
) =>
  Effect.gen(function* () {
    const { context, projection, onChange } = options;
    // Refreshes run from polling and host callbacks, so capture HTTP and tracing at construction.
    const dependencies = (yield* Effect.context<JsonHttpClient>()).pipe(
      Context.pick(JsonHttpClient, Tracer.Tracer),
    );
    const path = yield* Path.Path;
    const provideDependencies = <A, E2>(
      effect: Effect.Effect<A, E2, JsonHttpClient>,
    ): Effect.Effect<A, E2> => Effect.provideContext(effect, dependencies);
    const agentDir = yield* AgentDirectory;
    const authPath = path.join(agentDir, "auth.json");
    const mergeState = mergeProjection<Resolved, Snapshot, P>;
    const state = yield* frozenProjection<P, P>(
      mergeState(options.initialProjection(), { config: options.initialConfig, authPath }),
      (current) => current,
      (published) => {
        if (options.canPublish?.() !== false) MutableRef.set(projection, published);
      },
    );
    const updateState = (f: (current: P) => P) =>
      state
        .transition((current) => {
          const next = f(current);
          return Effect.succeed([next, next] as const);
        })
        .pipe(Effect.orDie);
    const notifyHost = (operation: string, action: () => void) =>
      Effect.try(() => {
        if (options.canPublish?.() !== false) action();
      }).pipe(
        Effect.catch(() => Effect.logWarning(`${LOG_LABEL} UI recovery: ${operation}_failed.`)),
      );
    const notifyChanged = notifyHost("render", onChange);
    const notifyUser = (message: string, level: "info" | "warning") =>
      notifyHost("notify", () => notifyAtHostBoundary(MutableRef.get(context), message, level));
    const synchronizeState =
      options.synchronizeState ??
      ((current: P, ctx: ExtensionContext, clearUsage: boolean) =>
        (current.config ? options.eligibility(ctx, current.config) : Effect.succeed(false)).pipe(
          Effect.map((eligible) =>
            withUsageEligibility(current, eligible, clearUsage, {
              hiddenStatusText: options.hiddenStatusText,
            }),
          ),
        ));
    const synchronize = (clearUsage = false, config?: Resolved) =>
      state
        .transition((current) =>
          synchronizeState(
            config === undefined ? current : mergeState(current, { config }),
            MutableRef.get(context),
            clearUsage,
          ).pipe(Effect.map((next) => [undefined, next] as const)),
        )
        .pipe(Effect.orDie, Effect.asVoid);
    yield* provideDependencies(synchronize(true));

    const installState = (next: (current: P) => P, notify: boolean) =>
      Effect.gen(function* () {
        const latest = yield* updateState(next);
        yield* notifyChanged;
        if (notify) yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
      });
    const installHidden = (statusText: string, notify: boolean) =>
      installState(
        (current) =>
          mergeState(current, {
            eligible: false,
            snapshot: undefined,
            statusLine: undefined,
            error: undefined,
            statusText,
          }),
        notify,
      );
    const installUnavailable = (
      message: string,
      fetchedAt: number,
      patch: Partial<P> | undefined,
      notify: boolean,
    ) =>
      installState(
        (current) =>
          mergeState(
            current,
            {
              eligible: true,
              snapshot: undefined,
              statusLine: undefined,
              error: message,
              statusText: `Usage unavailable: ${failureMessage(message, "unknown error")}`,
              lastFetchAt: fetchedAt,
            },
            patch,
          ),
        notify,
      );

    const key = Effect.gen(function* () {
      const ctx = MutableRef.get(context);
      const current = yield* state.getState;
      const segments = [
        hostModelKey(ctx),
        String(options.backgroundEnabled?.() ?? true),
        String(current.config?.usage.showOnlyOnSubscriptionModels ?? true),
      ];
      return segments.join(":");
    });
    const refreshEngine = yield* createSubscriptionRefresh<
      string,
      RefreshValue<Snapshot, Partial<P>>,
      never,
      JsonHttpClient
    >({
      currentKey: key,
      interval: state.getState.pipe(
        Effect.map((current) => current.config?.usage.refreshIntervalMs ?? 60_000),
      ),
      fetch: (request) =>
        Effect.gen(function* () {
          const notify = request.notify === true;
          const ctx = MutableRef.get(context);
          const current = yield* state.getState;
          const cfg = current.config;
          if (options.canPublish?.() === false || !cfg || !hostHasUi(ctx))
            return RefreshValue.Skipped();
          const now = yield* Clock.currentTimeMillis;
          if (!notify && options.backgroundEnabled?.() === false)
            return RefreshValue.Disabled({ notify });
          if (!(yield* options.eligibility(ctx, cfg))) return RefreshValue.Hidden({ notify });
          if (
            !request.force &&
            !request.notify &&
            current.lastFetchAt !== undefined &&
            now - current.lastFetchAt < cfg.usage.refreshIntervalMs
          )
            return RefreshValue.Skipped();
          const outcome = yield* options.fetchOutcome({ ctx });
          return RefreshValue.Fetched({ outcome, notify, fetchedAt: now });
        }),
      commit: (value) =>
        Match.valueTags(value, {
          Skipped: () => Effect.void,
          Disabled: ({ notify }) => installHidden("Usage is hidden in Cosmic UI", notify),
          Hidden: ({ notify }) => installHidden(options.hiddenStatusText, notify),
          Fetched: ({ outcome, notify, fetchedAt }) =>
            Match.valueTags(outcome, {
              Missing: () =>
                Effect.logWarning(`${LOG_LABEL} usage recovery: credentials_missing.`).pipe(
                  Effect.andThen(
                    installUnavailable(
                      options.missingCredentialsMessage,
                      fetchedAt,
                      options.clearAuthPatch,
                      notify,
                    ),
                  ),
                ),
              Failure: ({ message, patch }) =>
                Effect.logWarning(`${LOG_LABEL} usage recovery: refresh_failed.`).pipe(
                  Effect.andThen(installUnavailable(message, fetchedAt, patch, notify)),
                ),
              Success: ({ snapshot, patch }) =>
                installState(
                  (current) =>
                    mergeState(
                      current,
                      {
                        eligible: true,
                        snapshot,
                        statusLine:
                          current.config === undefined
                            ? undefined
                            : options.formatStatusLine(snapshot, current.config, fetchedAt),
                        statusText: options.formatStatusText(snapshot, fetchedAt),
                        error: undefined,
                        updatedAt: fetchedAt,
                        lastFetchAt: fetchedAt,
                      },
                      patch,
                    ),
                  notify,
                ),
            }),
        }),
      spanName: `${SPAN_PREFIX}.refresh`,
    });
    const refresh = (request: RefreshRequest = {}) =>
      provideDependencies(refreshEngine.request(request));
    // The controller is the projection's only writer, so hosts render after this transition.
    const contextChanged = (clearUsage = false) =>
      provideDependencies(refreshEngine.invalidateWith(synchronize(clearUsage))).pipe(
        Effect.andThen(notifyChanged),
      );
    const configure: UsageRefreshController<P, Resolved, Snapshot>["configure"] = (
      config,
      configureOptions,
    ) => {
      const invalidate = configureOptions?.invalidate !== false;
      const install = synchronize(invalidate, config);
      return provideDependencies(invalidate ? refreshEngine.invalidateWith(install) : install);
    };
    const startPolling = () =>
      refresh({ force: true }).pipe(
        recoverRefreshFailure(`${SPAN_PREFIX}.initial-refresh`),
        Effect.andThen(provideDependencies(refreshEngine.startPolling({}))),
        Effect.forkScoped,
        Effect.asVoid,
      );
    const controller: UsageRefreshController<P, Resolved, Snapshot> = {
      refresh,
      startPolling,
      contextChanged,
      getState: state.getState,
      updateState,
      configure,
    };
    return controller;
  });

export class OpenAIBoundaryError extends Schema.TaggedError<OpenAIBoundaryError>()(
  "OpenAIBoundaryError",
  { operation: Schema.Literals(["runtime", "config"]), message: Schema.String },
) {}
export const sessionNotStarted = (operation: OpenAIBoundaryError["operation"] = "runtime") =>
  new OpenAIBoundaryError({ operation, message: "Better OpenAI session has not started." });
const timedDiagnosticResult = <A, E extends { readonly message?: string | undefined }, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMessage: string,
): Effect.Effect<Result.Result<A, string>, never, R> =>
  effect.pipe(
    Effect.mapError((failure) => failure.message ?? timeoutMessage),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(timeoutMessage) }),
    Effect.mapError((message) => sanitizeDiagnosticError(message)),
    Effect.result,
  );

interface OpenAIUsageServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly onChange: () => void;
  readonly canPublish?: () => boolean;
  readonly startPolling?: boolean;
  readonly isUsageVisible?: () => boolean;
}

export class OpenAIUsageService extends Context.Service<OpenAIUsageService>()(
  "pi-better-openai/usage/controller/OpenAIUsageService",
  {
    make: Effect.fnUntraced(function* (options: OpenAIUsageServiceOptions) {
      const config = yield* OpenAIConfigService;
      const controller = yield* makeUsageRefreshController<
        OpenAIProjection,
        ResolvedConfig,
        UsageSnapshot
      >({
        context: options.context,
        initialConfig: yield* config.get,
        projection: options.projection,
        onChange: options.onChange,
        canPublish: options.canPublish,
        backgroundEnabled: options.isUsageVisible,
        initialProjection,
        hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
        missingCredentialsMessage: "Sign in with /login openai-codex",
        clearAuthPatch: { authFound: false, accountId: undefined },
        eligibility: (ctx, cfg) => Effect.succeed(isOpenAISubscriptionModel(ctx, cfg)),
        synchronizeState: (current, ctx, clearUsage) =>
          Effect.succeed(synchronizedProjection(current, ctx, clearUsage)),
        fetchOutcome: ({ ctx }) =>
          Effect.gen(function* () {
            const authAttempt = yield* timedDiagnosticResult(
              getCodexCredentials(ctx),
              "Codex credential lookup timed out.",
            );
            if (Result.isFailure(authAttempt))
              return UsageFetchOutcome.Failure({ message: authAttempt.failure });
            const credentials = authAttempt.success;
            if (credentials === undefined) return UsageFetchOutcome.Missing();
            const authPatch = { authFound: true, accountId: credentials.accountId } as const;
            const usage = yield* timedDiagnosticResult(
              requestCodexUsageWithCredentials(credentials),
              "Codex usage request timed out.",
            );
            if (Result.isFailure(usage))
              return UsageFetchOutcome.Failure({ message: usage.failure, patch: authPatch });
            return UsageFetchOutcome.Success({ snapshot: usage.success, patch: authPatch });
          }),
        formatStatusLine: (snapshot, cfg, fetchedAt) =>
          formatUsageSnapshot(snapshot, cfg.usage, fetchedAt),
        formatStatusText: formatUsageDetails,
      });
      yield* config.observe({
        commit: ({ previous, config: next, reason }) =>
          controller.configure(next, {
            invalidate: reason !== "fast" || usageConfigChanged(previous, next),
          }),
        settled: ({ reason }) =>
          reason === "setting" ? controller.refresh({ force: true }) : Effect.void,
      });
      if (options.startPolling !== false) yield* controller.startPolling();
      const lastVisible = yield* Ref.make(true);
      /**
       * Usage that just became visible or hidden refetches or clears at once, instead of waiting
       * for the next poll. Hosts call this after they observe Cosmic UI state; rendering doesn't.
       */
      const visibilityChanged = Effect.fn("OpenAIUsageService.visibilityChanged")(function* () {
        const visible = options.isUsageVisible?.() ?? true;
        if ((yield* Ref.getAndSet(lastVisible, visible)) === visible) return;
        yield* controller.contextChanged(true);
        yield* controller.refresh({ force: true });
      });
      return {
        refresh: controller.refresh,
        contextChanged: controller.contextChanged,
        visibilityChanged,
      };
    }, Effect.withSpan("pi-better-openai.usage.initialize")),
  },
) {
  static layer(options: OpenAIUsageServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
