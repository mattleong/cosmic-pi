import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import {
  AgentDirectory,
  JsonDocumentStore,
  JsonHttpClient,
  makeFrozenProjection,
  mergeRefreshRequest,
  makeSubscriptionRefresh,
  sanitizeDiagnosticError,
  withUsageEligibility,
  type RefreshRequest,
} from "pi-cosmic-core";
import { ModelRegistryAuth } from "../boundary/model-registry-auth.ts";
import {
  decodeSettingUpdate,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  updateConfig,
  type InvalidSettingError,
  type ResolvedConfig,
  type XaiConfigError,
} from "../config/index.ts";
import {
  type UsageSnapshot,
  formatUsageDetails,
  formatUsageSnapshot,
  requestXaiUsage,
} from "./format.ts";
import {
  HIDDEN_USAGE_STATUS_TEXT,
  initialXaiProjection,
  isXaiSubscriptionModel,
  type XaiProjection,
} from "./projection.ts";

export class XaiBoundaryError extends Schema.TaggedErrorClass<XaiBoundaryError>()(
  "XaiBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}

export type RefreshOptions = RefreshRequest;

export interface XaiUsageServiceShape {
  readonly refresh: (options?: RefreshOptions) => Effect.Effect<void>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly updateSetting: (
    id: string,
    value: string,
  ) => Effect.Effect<void, XaiConfigError | InvalidSettingError>;
}

type RefreshValue =
  | { readonly _tag: "Disabled"; readonly notify: boolean }
  | { readonly _tag: "Hidden"; readonly notify: boolean }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Missing"; readonly notify: boolean; readonly fetchedAt: number }
  | {
      readonly _tag: "Failure";
      readonly notify: boolean;
      readonly fetchedAt: number;
      readonly message: string;
    }
  | {
      readonly _tag: "Success";
      readonly notify: boolean;
      readonly fetchedAt: number;
      readonly snapshot: UsageSnapshot;
      readonly authFound: boolean;
      readonly teamId?: string;
    };

export class XaiUsageService extends Context.Service<XaiUsageService, XaiUsageServiceShape>()(
  "pi-better-xai/usage/controller/XaiUsageService",
) {
  static layer(options: {
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly cwd: string;
    readonly projection: MutableRef.MutableRef<XaiProjection>;
    readonly onChange: () => void;
    readonly startPolling?: boolean;
    readonly agentDir?: string;
    readonly projectTrusted?: boolean;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const { context, cwd, projection, onChange } = options;
        const path = yield* Path.Path;
        const documents = yield* JsonDocumentStore;
        const http = yield* JsonHttpClient;
        const registryAuth = yield* ModelRegistryAuth;
        const tracer = yield* Tracer.Tracer;
        const provideDependencies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(JsonDocumentStore, documents),
            Effect.provideService(JsonHttpClient, http),
            Effect.provideService(ModelRegistryAuth, registryAuth),
            Effect.provideService(Tracer.Tracer, tracer),
          );
        const agentDir = options.agentDir ?? (yield* AgentDirectory);
        const authPath = path.join(agentDir, "auth.json");
        const projectTrusted = options.projectTrusted ?? true;
        const config = yield* resolveConfig(cwd, agentDir, projectTrusted);
        const state = yield* makeFrozenProjection<XaiProjection, XaiProjection>(
          { ...initialXaiProjection(), config, authPath },
          (current) => current,
          (published) => MutableRef.set(projection, published),
        );
        const settingUpdates = yield* Semaphore.make(1);
        const updateState = (f: (current: XaiProjection) => XaiProjection) =>
          state
            .transition((current) => {
              const next = f(current);
              return Effect.succeed([next, next] as const);
            })
            .pipe(Effect.orDie);
        const notifyChanged = Effect.try({
          try: onChange,
          catch: () =>
            new XaiBoundaryError({
              operation: "render",
              message: "Unable to update Better xAI UI.",
            }),
        }).pipe(Effect.catch(() => Effect.void));
        const notifyUser = (message: string, level: "info" | "warning") =>
          Effect.try({
            try: () => MutableRef.get(context).ui.notify(message, level),
            catch: () =>
              new XaiBoundaryError({
                operation: "notify",
                message: "Unable to notify Better xAI status.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        const subscriptionEligibility = (ctx: ExtensionContext, cfg: ResolvedConfig) => {
          const model = ctx.model;
          if (!model || model.provider !== "xai") return Effect.succeed(false);
          if (!cfg.usage.showOnlyOnSubscriptionModels)
            return Effect.succeed(isXaiSubscriptionModel(ctx, cfg));
          return registryAuth.isUsingOAuth(model).pipe(
            Effect.map((isUsingOAuth) => isXaiSubscriptionModel(ctx, cfg, isUsingOAuth)),
            Effect.catch(() =>
              Effect.logWarning(
                "Better xAI authentication recovery: oauth_status_unavailable.",
              ).pipe(Effect.as(false)),
            ),
          );
        };
        const synchronize = (clearUsage = false) =>
          state
            .transition((current) => {
              const ctx = MutableRef.get(context);
              const eligible = current.config
                ? subscriptionEligibility(ctx, current.config)
                : Effect.succeed(false);
              return eligible.pipe(
                Effect.map(
                  (eligible) =>
                    [
                      undefined,
                      withUsageEligibility(current, eligible, clearUsage, {
                        hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
                      }),
                    ] as const,
                ),
              );
            })
            .pipe(Effect.orDie, Effect.asVoid);
        yield* synchronize(true);

        const key = Effect.gen(function* () {
          const ctx = MutableRef.get(context);
          const current = yield* state.getState;
          return `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}:${current.config?.usage.enabled ?? false}:${current.config?.usage.showOnlyOnSubscriptionModels ?? true}`;
        });
        const refreshEngine = yield* makeSubscriptionRefresh<
          RefreshOptions,
          string,
          RefreshValue,
          never,
          Path.Path | JsonDocumentStore | JsonHttpClient | ModelRegistryAuth
        >({
          mergeRequest: mergeRefreshRequest,
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
              if (!cfg) return { _tag: "Skipped" } as const;
              const now = yield* Clock.currentTimeMillis;
              if (!cfg.usage.enabled) return { _tag: "Disabled", notify } as const;
              if (!(yield* subscriptionEligibility(ctx, cfg)))
                return { _tag: "Hidden", notify } as const;
              if (
                !request.force &&
                !request.notify &&
                current.lastFetchAt !== undefined &&
                now - current.lastFetchAt < cfg.usage.refreshIntervalMs
              )
                return { _tag: "Skipped" } as const;
              const result = yield* requestXaiUsage(authPath).pipe(
                Effect.timeout("10 seconds"),
                Effect.result,
              );
              if (result._tag === "Failure") {
                const message = sanitizeDiagnosticError(
                  typeof result.failure.message === "string"
                    ? result.failure.message
                    : "xAI usage request timed out.",
                );
                return { _tag: "Failure", notify, fetchedAt: now, message } as const;
              }
              if (!result.success) return { _tag: "Missing", notify, fetchedAt: now } as const;
              return {
                _tag: "Success",
                notify,
                fetchedAt: now,
                snapshot: result.success.snapshot,
                authFound: true,
                ...(result.success.teamId ? { teamId: result.success.teamId } : {}),
              } as const;
            }),
          commit: (value) =>
            Effect.gen(function* () {
              if (value._tag === "Skipped") return;
              if (value._tag === "Failure")
                yield* Effect.logWarning("Better xAI usage recovery: refresh_failed.");
              if (value._tag === "Missing")
                yield* Effect.logWarning("Better xAI usage recovery: credentials_missing.");
              const latest = yield* updateState((current) => {
                const cfg = current.config!;
                if (value._tag === "Disabled" || value._tag === "Hidden")
                  return {
                    ...current,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText:
                      value._tag === "Disabled"
                        ? "Usage display is disabled."
                        : HIDDEN_USAGE_STATUS_TEXT,
                  };
                if (value._tag === "Failure" || value._tag === "Missing") {
                  const missing = value._tag === "Missing";
                  const message = missing
                    ? `Missing xAI OAuth credentials in ${authPath}. Run /login xai.`
                    : value.message;
                  return {
                    ...current,
                    eligible: true,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: message,
                    statusText: `Usage unavailable: ${message}`,
                    lastFetchAt: value.fetchedAt,
                    ...(missing ? { authFound: false, teamId: undefined } : {}),
                  };
                }
                return {
                  ...current,
                  eligible: true,
                  snapshot: value.snapshot,
                  statusLine: formatUsageSnapshot(value.snapshot, cfg.usage, value.fetchedAt),
                  statusText: formatUsageDetails(value.snapshot, value.fetchedAt),
                  error: undefined,
                  updatedAt: value.fetchedAt,
                  lastFetchAt: value.fetchedAt,
                  authFound: value.authFound,
                  teamId: value.teamId,
                };
              });
              yield* notifyChanged;
              if ("notify" in value && value.notify)
                yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
            }),
          spanName: "pi-better-xai.usage.refresh",
        });
        const refresh = (request: RefreshOptions = {}) =>
          provideDependencies(refreshEngine.request(request));
        const contextChanged = (clearUsage = false) =>
          synchronize(clearUsage).pipe(Effect.andThen(refreshEngine.invalidate), Effect.asVoid);
        const resolveSettingTarget = Effect.fn("XaiUsageService.resolveSettingTarget")(
          function* () {
            const current = yield* resolveConfig(cwd, agentDir, projectTrusted);
            const globalFallback =
              current.configPath === current.projectConfigPath && current.globalConfigExists
                ? yield* readRawConfig(current.globalConfigPath).pipe(
                    Effect.provideService(JsonDocumentStore, documents),
                  )
                : undefined;
            return { current, globalFallback } as const;
          },
        );
        const updateSettingWithRequirements = Effect.fn("XaiUsageService.updateSetting")(function* (
          id: string,
          value: string,
        ) {
          const update = yield* decodeSettingUpdate(id, value);
          yield* settingUpdates.withPermit(
            Effect.gen(function* () {
              if (!(yield* state.getState).config) return;
              const { current: currentConfig, globalFallback } = yield* resolveSettingTarget();
              yield* updateConfig(currentConfig.configPath, update, (committed) => {
                const nextConfig = resolveCommittedConfig(currentConfig, committed, globalFallback);
                return updateState((latest) => ({ ...latest, config: nextConfig })).pipe(
                  Effect.andThen(synchronize(true)),
                );
              }).pipe(Effect.provideService(JsonDocumentStore, documents));
            }),
          );
          yield* refreshEngine.invalidate;
          yield* refresh({ force: true });
        });
        const updateSetting = (id: string, value: string) =>
          provideDependencies(updateSettingWithRequirements(id, value));
        if (options.startPolling !== false) {
          yield* Effect.gen(function* () {
            yield* refresh({ force: true });
            yield* provideDependencies(refreshEngine.startPolling({}));
          }).pipe(Effect.forkScoped);
        }
        return XaiUsageService.of({ refresh, contextChanged, updateSetting });
      }).pipe(Effect.withSpan("pi-better-xai.usage.initialize")),
    ).pipe(
      Layer.provide(ModelRegistryAuth.layer(() => MutableRef.get(options.context).modelRegistry)),
    );
  }
}
