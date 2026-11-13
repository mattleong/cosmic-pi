import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
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
import * as Tracer from "effect/Tracer";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import {
  createSubscriptionRefresh,
  recoverRefreshFailure,
} from "pi-cosmic-core/coordination/subscription-refresh";
import { failureMessage } from "pi-cosmic-core/message-text";
import { frozenProjection } from "pi-cosmic-core/projection";
import { invokeHostCallback, notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { JsonHttpClient } from "pi-cosmic-core/platform/json-http";
import { sanitizeDiagnosticError } from "pi-cosmic-core/security";
import { type RefreshRequest } from "pi-cosmic-core/coordination/refresh-coordinator";
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
  type OpenAIProjection,
} from "./projection.ts";

const SPAN_PREFIX = "pi-better-openai.usage";
const LOG_LABEL = "Better OpenAI";

type AuthPatch = Pick<OpenAIProjection, "authFound" | "accountId">;

export type UsageFetchOutcome = Data.TaggedEnum<{
  Missing: Record<never, never>;
  Failure: { readonly message: string; readonly patch?: AuthPatch };
  Success: { readonly snapshot: UsageSnapshot; readonly patch: AuthPatch };
}>;

export const UsageFetchOutcome = Data.taggedEnum<UsageFetchOutcome>();

const hostHasUi = (ctx: ExtensionContext): boolean => invokeHostCallback(() => ctx.hasUI, true);
const hostModelKey = (ctx: ExtensionContext): string =>
  invokeHostCallback(() => {
    const model = ctx.model;
    return `${model?.provider ?? "none"}/${model?.id ?? "none"}`;
  }, "unavailable");

type RefreshValue = Data.TaggedEnum<{
  Skipped: Record<never, never>;
  Disabled: { readonly notify: boolean };
  Hidden: { readonly notify: boolean };
  Fetched: {
    readonly outcome: UsageFetchOutcome;
    readonly notify: boolean;
    readonly fetchedAt: number;
  };
}>;

const RefreshValue = Data.taggedEnum<RefreshValue>();

export interface UsageRefreshControllerOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly onChange: () => void;
  readonly canPublish?: (() => boolean) | undefined;
  readonly backgroundEnabled?: (() => boolean) | undefined;
  readonly initialConfig: ResolvedConfig;
  readonly fetchOutcome: (
    ctx: ExtensionContext,
  ) => Effect.Effect<UsageFetchOutcome, never, JsonHttpClient>;
}

export const makeUsageRefreshController = Effect.fn("UsageRefreshController.make")(function* (
  options: UsageRefreshControllerOptions,
) {
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
  const state = yield* frozenProjection<OpenAIProjection, OpenAIProjection>(
    { ...initialProjection(), config: options.initialConfig, authPath },
    (current) => current,
    (published) => {
      if (options.canPublish?.() !== false) MutableRef.set(projection, published);
    },
  );
  const updateState = (f: (current: OpenAIProjection) => OpenAIProjection) =>
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
  const synchronize = (clearUsage = false, config?: ResolvedConfig) =>
    state
      .transition((current) =>
        Effect.succeed([
          undefined,
          synchronizedProjection(
            config === undefined ? current : { ...current, config },
            MutableRef.get(context),
            clearUsage,
          ),
        ] as const),
      )
      .pipe(Effect.orDie, Effect.asVoid);
  yield* synchronize(true);

  // Usage hidden for the current model is a normal state; only a failed read warns.
  const installState = Effect.fnUntraced(function* (
    next: (current: OpenAIProjection) => OpenAIProjection,
    notify: boolean,
    hidden = false,
  ) {
    const latest = yield* updateState(next);
    yield* notifyChanged;
    if (notify)
      yield* notifyUser(latest.statusText, hidden || latest.snapshot ? "info" : "warning");
  });
  const installHidden = (statusText: string, notify: boolean) =>
    installState(
      (current) => ({
        ...current,
        eligible: false,
        snapshot: undefined,
        statusLine: undefined,
        error: undefined,
        statusText,
      }),
      notify,
      true,
    );
  const installUnavailable = (
    message: string,
    fetchedAt: number,
    patch: AuthPatch | undefined,
    notify: boolean,
  ) =>
    installState(
      (current) => ({
        ...current,
        eligible: true,
        snapshot: undefined,
        statusLine: undefined,
        error: message,
        statusText: `Usage unavailable: ${failureMessage(message, "unknown error")}`,
        lastFetchAt: fetchedAt,
        ...patch,
      }),
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
    return Arr.join(segments, ":");
  });
  const refreshEngine = yield* createSubscriptionRefresh<
    string,
    RefreshValue,
    never,
    JsonHttpClient
  >({
    currentKey: key,
    interval: state.getState.pipe(
      Effect.map((current) => current.config?.usage.refreshIntervalMs ?? 60_000),
    ),
    fetch: Effect.fnUntraced(function* (request) {
      const notify = request.notify === true;
      const ctx = MutableRef.get(context);
      const current = yield* state.getState;
      const cfg = current.config;
      if (options.canPublish?.() === false || !cfg || !hostHasUi(ctx))
        return RefreshValue.Skipped();
      const now = yield* Clock.currentTimeMillis;
      if (!notify && options.backgroundEnabled?.() === false)
        return RefreshValue.Disabled({ notify });
      if (!isOpenAISubscriptionModel(ctx, cfg)) return RefreshValue.Hidden({ notify });
      if (
        !request.force &&
        !request.notify &&
        current.lastFetchAt !== undefined &&
        now - current.lastFetchAt < cfg.usage.refreshIntervalMs
      )
        return RefreshValue.Skipped();
      const outcome = yield* options.fetchOutcome(ctx);
      return RefreshValue.Fetched({ outcome, notify, fetchedAt: now });
    }),
    commit: (value) =>
      Match.valueTags(value, {
        Skipped: () => Effect.void,
        Disabled: ({ notify }) => installHidden("Usage is hidden in Cosmic UI", notify),
        Hidden: ({ notify }) => installHidden(HIDDEN_USAGE_STATUS_TEXT, notify),
        Fetched: ({ outcome, notify, fetchedAt }) =>
          Match.valueTags(outcome, {
            Missing: () =>
              Effect.logWarning(`${LOG_LABEL} usage recovery: credentials_missing.`).pipe(
                Effect.andThen(
                  installUnavailable(
                    "Sign in with /login openai-codex",
                    fetchedAt,
                    { authFound: false, accountId: undefined },
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
                (current) => ({
                  ...current,
                  eligible: true,
                  snapshot,
                  statusLine:
                    current.config === undefined
                      ? undefined
                      : formatUsageSnapshot(snapshot, current.config.usage, fetchedAt),
                  statusText: formatUsageDetails(snapshot, fetchedAt),
                  error: undefined,
                  updatedAt: fetchedAt,
                  lastFetchAt: fetchedAt,
                  ...patch,
                }),
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
    refreshEngine.invalidateWith(synchronize(clearUsage)).pipe(Effect.andThen(notifyChanged));
  const configure = (
    config: ResolvedConfig,
    configureOptions?: { readonly invalidate?: boolean },
  ) => {
    const invalidate = configureOptions?.invalidate !== false;
    const install = synchronize(invalidate, config);
    return invalidate ? refreshEngine.invalidateWith(install) : install;
  };
  const startPolling = () =>
    refresh({ force: true }).pipe(
      recoverRefreshFailure(`${SPAN_PREFIX}.initial-refresh`),
      Effect.andThen(provideDependencies(refreshEngine.startPolling({}))),
      Effect.forkScoped,
      Effect.asVoid,
    );
  return { refresh, startPolling, contextChanged, getState: state.getState, configure };
});

export class OpenAIBoundaryError extends Schema.TaggedError<
  OpenAIBoundaryError,
  { readonly brand: unique symbol }
>()("OpenAIBoundaryError", {
  operation: Schema.Literals(["runtime", "config"]),
  message: Schema.String,
}) {}
export const sessionNotStarted = (operation: OpenAIBoundaryError["operation"] = "runtime") =>
  OpenAIBoundaryError.make({ operation, message: "Better OpenAI session has not started." });
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

const codexUsageOutcome = Effect.fnUntraced(function* (ctx: ExtensionContext) {
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
});

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
      const controller = yield* makeUsageRefreshController({
        context: options.context,
        initialConfig: yield* config.get,
        projection: options.projection,
        onChange: options.onChange,
        canPublish: options.canPublish,
        backgroundEnabled: options.isUsageVisible,
        fetchOutcome: codexUsageOutcome,
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
