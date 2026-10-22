import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import type * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import type { RefreshRequest } from "./coordination/refresh-coordinator.ts";
import { createSubscriptionRefresh } from "./coordination/subscription-refresh.ts";
import { AgentDirectory } from "./platform/agent-directory.ts";
import { JsonHttpClient } from "./platform/json-http.ts";
import { invokeHostCallback } from "./host-session.ts";
import { frozenProjection } from "./projection.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./security.ts";
import { formatTimestampOrNever } from "./subscription-format.ts";
import { withUsageEligibility, type UsageProjectionBase } from "./usage-projection.ts";
import { formatDuration } from "./display.ts";
import { failureMessage, notificationText } from "./message-text.ts";

interface UsageControllerConfigFields {
  readonly refreshIntervalMs: number;
  readonly showOnlyOnSubscriptionModels: boolean;
}

export interface SubscriptionUsageConfig extends UsageControllerConfigFields {
  readonly showResetTimes: boolean;
}

export interface UsageControllerConfig {
  readonly usage: UsageControllerConfigFields;
}

type UsageProviderRequirements = JsonHttpClient;

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
  R = never,
> {
  readonly spanPrefix: string;
  readonly logLabel: string;
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
  ) => Effect.Effect<boolean, never, UsageProviderRequirements | R>;
  readonly synchronizeState?: (
    current: P,
    ctx: ExtensionContext,
    clearUsage: boolean,
  ) => Effect.Effect<P, never, UsageProviderRequirements | R>;
  readonly fetchOutcome: (args: {
    readonly ctx: ExtensionContext;
  }) => Effect.Effect<
    UsageFetchOutcome<Snapshot, Partial<P>>,
    never,
    UsageProviderRequirements | R
  >;
  readonly formatStatusLine: (snapshot: Snapshot, cfg: Resolved, fetchedAt: number) => string;
  readonly formatStatusText: (snapshot: Snapshot, fetchedAt: number) => string;
  readonly dependencies: Context.Context<R>;
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
  R = never,
>(
  options: UsageRefreshControllerOptions<P, Resolved, Snapshot, R>,
) =>
  Effect.gen(function* () {
    const { context, projection, onChange, logLabel } = options;
    const ambientDependencies = yield* Effect.context<UsageProviderRequirements>();
    const sharedDependencies = ambientDependencies.pipe(
      Context.pick(JsonHttpClient, Tracer.Tracer),
    );
    const dependencies = Context.merge(options.dependencies, sharedDependencies);
    const path = yield* Path.Path;
    const provideDependencies = <A, E2>(
      effect: Effect.Effect<A, E2, UsageProviderRequirements | R>,
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
        Effect.catch(() => Effect.logWarning(`${logLabel} UI recovery: ${operation}_failed.`)),
      );
    const notifyChanged = notifyHost("render", onChange);
    const notifyUser = (message: string, level: "info" | "warning") =>
      notifyHost("notify", () =>
        MutableRef.get(context).ui.notify(notificationText(message), level),
      );
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
        `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}`,
        String(options.backgroundEnabled?.() ?? true),
        String(current.config?.usage.showOnlyOnSubscriptionModels ?? true),
      ];
      return segments.join(":");
    });
    const refreshEngine = yield* createSubscriptionRefresh<
      string,
      RefreshValue<Snapshot, Partial<P>>,
      never,
      UsageProviderRequirements | R
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
                Effect.logWarning(`${logLabel} usage recovery: credentials_missing.`).pipe(
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
                Effect.logWarning(`${logLabel} usage recovery: refresh_failed.`).pipe(
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
      spanName: `${options.spanPrefix}.refresh`,
    });
    const refresh = (request: RefreshRequest = {}) =>
      provideDependencies(refreshEngine.request(request));
    const contextChanged = (clearUsage = false) =>
      provideDependencies(refreshEngine.invalidateWith(synchronize(clearUsage)));
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

interface UsageDebugReport {
  readonly currentModel: string;
  readonly requiresSubscriptionModel: boolean;
  readonly identityLabel: string;
  readonly identityValue: string | undefined;
  readonly refreshIntervalMs: number;
  readonly endpoint: string;
}

export function formatUsageDebugReport(
  state: UsageProjectionBase<unknown, unknown>,
  report: UsageDebugReport,
): string {
  return [
    `Current model: ${report.currentModel}`,
    `Current model eligible: ${state.eligible}`,
    `Requires subscription model: ${report.requiresSubscriptionModel}`,
    `Auth: ${state.authFound ? "found" : "missing"}`,
    `${report.identityLabel}: ${maskIdentifier(report.identityValue) ?? "none"}`,
    `Last fetch: ${formatTimestampOrNever(state.lastFetchAt)}`,
    `Last successful update: ${formatTimestampOrNever(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${formatDuration(report.refreshIntervalMs)}`,
    `Endpoint: ${report.endpoint}`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}

export const timedDiagnosticResult = <A, E extends { readonly message?: string | undefined }, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMessage: string,
): Effect.Effect<Result.Result<A, string>, never, R> =>
  effect.pipe(
    Effect.mapError((failure) => failure.message ?? timeoutMessage),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(timeoutMessage) }),
    Effect.mapError((message) => sanitizeDiagnosticError(message)),
    Effect.result,
  );
