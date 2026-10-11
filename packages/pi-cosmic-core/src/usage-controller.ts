import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import type * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import type { RefreshRequest } from "./coordination/refresh-coordinator.ts";
import { makeSubscriptionRefresh } from "./coordination/subscription-refresh.ts";
import {
  commitPreferredScope,
  type PreferredScopeStore,
  type ScopedConfigMetadata,
  type ScopedConfigStore,
} from "./config/scoped-config-store.ts";
import { AgentDirectory } from "./platform/agent-directory.ts";
import { JsonDocumentStore, type JsonObject } from "./platform/json-document.ts";
import { JsonHttpClient } from "./platform/json-http.ts";
import { invokeHostCallback } from "./host-session.ts";
import { makeFrozenProjection } from "./projection.ts";
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

export type UsageControllerConfig = ScopedConfigMetadata & {
  readonly usage: UsageControllerConfigFields;
};

type UsageProviderRequirements = Path.Path | JsonDocumentStore | JsonHttpClient;

export type UsageFetchOutcome<Snapshot, Patch> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failure"; readonly message: string; readonly patch?: Patch }
  | { readonly _tag: "Success"; readonly snapshot: Snapshot; readonly patch: Patch };

const hostHasUi = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.hasUI !== false, true);

type RefreshValue<Snapshot, Patch> =
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Disabled"; readonly notify: boolean }
  | { readonly _tag: "Hidden"; readonly notify: boolean }
  | (UsageFetchOutcome<Snapshot, Patch> & {
      readonly notify: boolean;
      readonly fetchedAt: number;
    });

type UsageControllerStore<Resolved extends ScopedConfigMetadata, E> = PreferredScopeStore<
  Resolved,
  E
> &
  Pick<ScopedConfigStore<unknown, Resolved, E>, "resolveConfig">;

export interface UsageRefreshControllerOptions<
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
  E,
  EI,
  R,
> {
  readonly spanPrefix: string;
  readonly logLabel: string;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projection: MutableRef.MutableRef<P>;
  readonly onChange: () => void;
  readonly canPublish?: (() => boolean) | undefined;
  readonly startPolling?: boolean | undefined;
  readonly backgroundEnabled?: (() => boolean) | undefined;
  readonly projectTrusted?: boolean | undefined;
  readonly initialProjection: () => P;
  readonly hiddenStatusText: string;
  readonly missingCredentialsMessage: string;
  readonly clearAuthPatch: Partial<P>;
  readonly store: UsageControllerStore<Resolved, E>;
  readonly decodeSettingUpdate: (
    id: string,
    value: string,
  ) => Effect.Effect<(document: JsonObject) => JsonObject, EI>;
  readonly eligibility: (
    ctx: ExtensionContext,
    cfg: Resolved,
  ) => Effect.Effect<boolean, never, UsageProviderRequirements | R>;
  readonly synchronizeState?: (
    current: P,
    ctx: ExtensionContext,
    clearUsage: boolean,
  ) => Effect.Effect<P, never, UsageProviderRequirements | R>;
  readonly refreshKeyScope?: ((ctx: ExtensionContext) => string) | undefined;
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
  E,
  EI,
  R,
> {
  readonly refresh: (request?: RefreshRequest) => Effect.Effect<void>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly updateSetting: (id: string, value: string) => Effect.Effect<void, E | EI>;
  readonly agentDir: string;
  readonly getState: Effect.Effect<P>;
  readonly updateState: (f: (current: P) => P) => Effect.Effect<P>;
  readonly installConfig: (config: Resolved) => Effect.Effect<void>;
  readonly withSettingsPermit: <A, E2, R2>(
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
  readonly provideDependencies: <A, E2>(
    effect: Effect.Effect<A, E2, UsageProviderRequirements | R>,
  ) => Effect.Effect<A, E2>;
}

export const makeUsageRefreshController = <
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
  E,
  EI,
  R = never,
>(
  options: UsageRefreshControllerOptions<P, Resolved, Snapshot, E, EI, R>,
) =>
  Effect.gen(function* () {
    const { context, cwd, projection, onChange, logLabel, store } = options;
    const ambientDependencies = yield* Effect.context<UsageProviderRequirements>();
    const sharedDependencies = ambientDependencies.pipe(
      Context.pick(Path.Path, JsonDocumentStore, JsonHttpClient, Tracer.Tracer),
    );
    const dependencies = Context.merge(options.dependencies, sharedDependencies);
    const path = Context.get(sharedDependencies, Path.Path);
    const provideDependencies = <A, E2>(
      effect: Effect.Effect<A, E2, UsageProviderRequirements | R>,
    ): Effect.Effect<A, E2> => Effect.provideContext(effect, dependencies);
    const agentDir = yield* AgentDirectory;
    const authPath = path.join(agentDir, "auth.json");
    const projectTrusted = options.projectTrusted === true;
    const config = yield* store.resolveConfig(cwd, agentDir, projectTrusted);
    const mergeState = (
      current: P,
      base: Partial<UsageProjectionBase<Resolved, Snapshot>>,
      patch?: Partial<P>,
    ): P => ({ ...current, ...base, ...patch });
    const state = yield* makeFrozenProjection<P, P>(
      mergeState(options.initialProjection(), { config, authPath }),
      (current) => current,
      (published) => {
        if (options.canPublish?.() !== false) MutableRef.set(projection, published);
      },
    );
    const settingUpdates = yield* Semaphore.make(1);
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
    const synchronize = (clearUsage = false) =>
      state
        .transition((current) =>
          synchronizeState(current, MutableRef.get(context), clearUsage).pipe(
            Effect.map((next) => [undefined, next] as const),
          ),
        )
        .pipe(Effect.orDie, Effect.asVoid);
    yield* synchronize(true);

    const key = Effect.gen(function* () {
      const ctx = MutableRef.get(context);
      const current = yield* state.getState;
      const segments = [
        `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}`,
        ...(options.refreshKeyScope ? [options.refreshKeyScope(ctx)] : []),
        String(options.backgroundEnabled?.() ?? true),
        String(current.config?.usage.showOnlyOnSubscriptionModels ?? true),
      ];
      return segments.join(":");
    });
    const refreshEngine = yield* makeSubscriptionRefresh<
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
            return { _tag: "Skipped" } as const;
          const now = yield* Clock.currentTimeMillis;
          if (!notify && options.backgroundEnabled?.() === false)
            return { _tag: "Disabled", notify } as const;
          if (!(yield* options.eligibility(ctx, cfg))) return { _tag: "Hidden", notify } as const;
          if (
            !request.force &&
            !request.notify &&
            current.lastFetchAt !== undefined &&
            now - current.lastFetchAt < cfg.usage.refreshIntervalMs
          )
            return { _tag: "Skipped" } as const;
          const outcome = yield* options.fetchOutcome({ ctx });
          return { ...outcome, notify, fetchedAt: now };
        }),
      commit: (value) =>
        Effect.gen(function* () {
          if (value._tag === "Skipped") return;
          if (value._tag === "Failure")
            yield* Effect.logWarning(`${logLabel} usage recovery: refresh_failed.`);
          if (value._tag === "Missing")
            yield* Effect.logWarning(`${logLabel} usage recovery: credentials_missing.`);
          const latest = yield* updateState((current) => {
            const cfg = current.config;
            if (value._tag === "Disabled" || value._tag === "Hidden")
              return mergeState(current, {
                eligible: false,
                snapshot: undefined,
                statusLine: undefined,
                error: undefined,
                statusText:
                  value._tag === "Disabled"
                    ? "Usage is hidden in Cosmic UI"
                    : options.hiddenStatusText,
              });
            if (value._tag === "Failure" || value._tag === "Missing") {
              const missing = value._tag === "Missing";
              const message = missing ? options.missingCredentialsMessage : value.message;
              return mergeState(
                current,
                {
                  eligible: true,
                  snapshot: undefined,
                  statusLine: undefined,
                  error: message,
                  statusText: `Usage unavailable: ${failureMessage(message, "unknown error")}`,
                  lastFetchAt: value.fetchedAt,
                },
                missing ? options.clearAuthPatch : value.patch,
              );
            }
            return mergeState(
              current,
              {
                eligible: true,
                snapshot: value.snapshot,
                statusLine:
                  cfg === undefined
                    ? undefined
                    : options.formatStatusLine(value.snapshot, cfg, value.fetchedAt),
                statusText: options.formatStatusText(value.snapshot, value.fetchedAt),
                error: undefined,
                updatedAt: value.fetchedAt,
                lastFetchAt: value.fetchedAt,
              },
              value.patch,
            );
          });
          yield* notifyChanged;
          if ("notify" in value && value.notify)
            yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
        }),
      spanName: `${options.spanPrefix}.refresh`,
    });
    const refresh = (request: RefreshRequest = {}) =>
      provideDependencies(refreshEngine.request(request));
    const contextChanged = (clearUsage = false) =>
      provideDependencies(refreshEngine.invalidateWith(synchronize(clearUsage)));
    const installConfig = (config: Resolved) =>
      provideDependencies(
        refreshEngine.invalidateWith(
          updateState((latest) => mergeState(latest, { config })).pipe(
            Effect.andThen(synchronize(true)),
          ),
        ),
      );
    const updateSettingWithRequirements = Effect.fn(`${options.spanPrefix}.updateSetting`)(
      function* (id: string, value: string) {
        const update = yield* options.decodeSettingUpdate(id, value);
        yield* settingUpdates.withPermit(
          store
            .resolveConfig(cwd, agentDir, projectTrusted)
            .pipe(
              Effect.flatMap((fresh) => commitPreferredScope(store, fresh, update, installConfig)),
            ),
        );
        yield* refresh({ force: true });
      },
    );
    const updateSetting = (id: string, value: string) =>
      provideDependencies(updateSettingWithRequirements(id, value));
    if (options.startPolling !== false)
      yield* refresh({ force: true }).pipe(
        Effect.andThen(provideDependencies(refreshEngine.startPolling({}))),
        Effect.forkScoped,
      );
    const controller: UsageRefreshController<P, Resolved, Snapshot, E, EI, R> = {
      refresh,
      contextChanged,
      updateSetting,
      agentDir,
      getState: state.getState,
      updateState,
      installConfig,
      withSettingsPermit: (effect) => settingUpdates.withPermit(effect),
      provideDependencies,
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
