import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import {
  AgentDirectory,
  freezeSnapshot,
  JsonDocumentStore,
  JsonHttpClient,
  makeFrozenProjection,
  mergeRefreshRequest,
  makeSubscriptionRefresh,
  maskIdentifier,
  sanitizeDiagnosticError,
  withUsageEligibility,
  type RefreshRequest,
} from "pi-cosmic-core";
import { ModelRegistryAuth, isUsingOAuthAtHostBoundary } from "../boundary/model-registry-auth.ts";
import { readXaiAuth } from "../auth/auth.ts";
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
  BILLING_BASE_URL,
  type UsageSnapshot,
  formatUsageDetails,
  formatUsageSnapshot,
  requestXaiUsage,
} from "./format.ts";

export interface XaiProjection {
  readonly config: ResolvedConfig | undefined;
  readonly eligible: boolean;
  readonly snapshot: UsageSnapshot | undefined;
  readonly statusLine: string | undefined;
  readonly statusText: string;
  readonly error: string | undefined;
  readonly lastFetchAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly authPath: string | undefined;
  readonly authFound: boolean;
  readonly teamId: string | undefined;
}

const initialProjection = (): XaiProjection => ({
  config: undefined,
  eligible: false,
  snapshot: undefined,
  statusLine: undefined,
  statusText: "Usage unavailable.",
  error: undefined,
  lastFetchAt: undefined,
  updatedAt: undefined,
  authPath: undefined,
  authFound: false,
  teamId: undefined,
});

export const makeProjection = (): MutableRef.MutableRef<XaiProjection> =>
  MutableRef.make(freezeSnapshot(initialProjection()));

export function resetProjection(projection: MutableRef.MutableRef<XaiProjection>): void {
  MutableRef.set(projection, freezeSnapshot(initialProjection()));
}

export function isXaiSubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth = false,
): boolean {
  const model = ctx.model;
  if (!model || model.provider !== "xai") return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || isUsingOAuth;
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  const state = MutableRef.get(projection);
  const model = ctx.model;
  const isUsingOAuth =
    model?.provider === "xai" && state.config?.usage.showOnlyOnSubscriptionModels
      ? isUsingOAuthAtHostBoundary(ctx.modelRegistry, model)
      : false;
  const eligible = state.config ? isXaiSubscriptionModel(ctx, state.config, isUsingOAuth) : false;
  MutableRef.set(
    projection,
    freezeSnapshot(
      withUsageEligibility(state, eligible, options.clearUsage ?? false, {
        hiddenStatusText: "Usage hidden: current model is not an xAI subscription model.",
      }),
    ),
  );
}

export function visibleStatusLine(
  projection: MutableRef.MutableRef<XaiProjection>,
): string | undefined {
  const state = MutableRef.get(projection);
  if (!state.config?.usage.enabled || !state.eligible) return undefined;
  return state.statusLine;
}

export class XaiBoundaryError extends Schema.TaggedErrorClass<XaiBoundaryError>()(
  "XaiBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface RefreshOptions extends RefreshRequest {}

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
          { ...initialProjection(), config, authPath },
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
          if (!cfg.usage.showOnlyOnSubscriptionModels) return Effect.succeed(true);
          return registryAuth
            .isUsingOAuth(model)
            .pipe(
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
                        hiddenStatusText:
                          "Usage hidden: current model is not an xAI subscription model.",
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
              const ctx = MutableRef.get(context);
              const current = yield* state.getState;
              const cfg = current.config;
              if (!cfg) return { _tag: "Skipped" } as const;
              const now = yield* Clock.currentTimeMillis;
              if (!cfg.usage.enabled)
                return { _tag: "Disabled", notify: request.notify === true } as const;
              if (!(yield* subscriptionEligibility(ctx, cfg)))
                return { _tag: "Hidden", notify: request.notify === true } as const;
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
                return {
                  _tag: "Failure",
                  notify: request.notify === true,
                  fetchedAt: now,
                  message,
                } as const;
              }
              if (!result.success)
                return {
                  _tag: "Missing",
                  notify: request.notify === true,
                  fetchedAt: now,
                } as const;
              const auth = yield* readXaiAuth(authPath).pipe(Effect.result);
              return {
                _tag: "Success",
                notify: request.notify === true,
                fetchedAt: now,
                snapshot: result.success,
                authFound: auth._tag === "Success" && auth.success !== undefined,
                ...(auth._tag === "Success" && auth.success?.teamId
                  ? { teamId: auth.success.teamId }
                  : {}),
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
                        : "Usage hidden: current model is not an xAI subscription model.",
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

export function formatDebug(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  const formatTime = (value: number | undefined) =>
    value === undefined ? "never" : DateTime.formatLocal(DateTime.makeUnsafe(value));
  return [
    `Usage enabled: ${cfg?.usage.enabled ?? false}`,
    `Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
    `Current model eligible: ${state.eligible}`,
    `Requires subscription model: ${cfg?.usage.showOnlyOnSubscriptionModels ?? true}`,
    `Auth: ${state.authFound ? "found" : "missing"}`,
    `Team ID: ${maskIdentifier(state.teamId) ?? "none"}`,
    `Last fetch: ${formatTime(state.lastFetchAt)}`,
    `Last successful update: ${formatTime(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${cfg?.usage.refreshIntervalMs ?? 60_000}ms`,
    `Endpoint: ${BILLING_BASE_URL}/billing*`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}
