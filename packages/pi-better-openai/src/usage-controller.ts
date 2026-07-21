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
  JsonDocumentStore,
  freezeSnapshot,
  JsonHttpClient,
  type JsonObject,
  makeFrozenProjection,
  makeSubscriptionRefresh,
  type RefreshRequest,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "./config.ts";
import {
  modifyConfig,
  prepareSettingUpdate,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  type InvalidSettingError,
  type OpenAIConfigError,
} from "./config.ts";
import { isModelUsingOAuth } from "./boundary/model-registry.ts";
import { currentModelKey } from "./fast-controller.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { getCodexCredentialsResult } from "./codex-auth.ts";
import {
  USAGE_URL,
  type CodexUsageResult,
  type UsageSnapshot,
  formatResetCountdown,
  formatUsageDetails,
  formatUsageSnapshot,
  requestCodexUsageWithCredentials,
  usageScopeForModel,
} from "./usage.ts";

export interface OpenAIProjection {
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
  readonly authSource: "modelRegistry" | "authFile" | undefined;
  readonly accountId: string | undefined;
}
const initial = (): OpenAIProjection => ({
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
  authSource: undefined,
  accountId: undefined,
});
export const makeProjection = () => MutableRef.make(freezeSnapshot(initial()));
export const resetProjection = (projection: MutableRef.MutableRef<OpenAIProjection>): void => {
  MutableRef.set(projection, freezeSnapshot(initial()));
};

function usageConfigChanged(left: ResolvedConfig, right: ResolvedConfig): boolean {
  return (
    left.usage.enabled !== right.usage.enabled ||
    left.usage.refreshIntervalMs !== right.usage.refreshIntervalMs ||
    left.usage.showOnlyOnSubscriptionModels !== right.usage.showOnlyOnSubscriptionModels ||
    left.usage.showResetTimes !== right.usage.showResetTimes
  );
}

export function isOpenAISubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || (isUsingOAuth ?? isModelUsingOAuth(ctx, model));
}

function synchronizedProjection(
  state: OpenAIProjection,
  ctx: ExtensionContext,
  clearUsage: boolean,
): OpenAIProjection {
  try {
    const eligible = state.config ? isOpenAISubscriptionModel(ctx, state.config) : false;
    const scopeMatches = state.snapshot?.scope === usageScopeForModel(ctx.model?.id);
    const statusText = eligible
      ? "Usage unavailable."
      : "Usage hidden: current model is not an OpenAI subscription model.";
    return {
      ...state,
      eligible,
      ...(clearUsage || !scopeMatches
        ? {
            snapshot: undefined,
            statusLine: undefined,
            error: undefined,
            updatedAt: undefined,
            statusText,
          }
        : !eligible
          ? { statusLine: undefined, error: undefined, statusText }
          : {}),
    };
  } catch {
    return {
      ...state,
      eligible: false,
      snapshot: undefined,
      statusLine: undefined,
      error: undefined,
      updatedAt: undefined,
      statusText: "Usage unavailable.",
    };
  }
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  MutableRef.set(
    projection,
    freezeSnapshot(
      synchronizedProjection(MutableRef.get(projection), ctx, options.clearUsage === true),
    ),
  );
}
export function visibleStatusLine(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
  isUsingOAuth?: boolean,
): string | undefined {
  if (!cfg.usage.enabled || !isOpenAISubscriptionModel(ctx, cfg, isUsingOAuth)) return undefined;
  const state = MutableRef.get(projection);
  return state.snapshot?.scope === usageScopeForModel(ctx.model?.id) ? state.statusLine : undefined;
}

export class OpenAIBoundaryError extends Schema.TaggedErrorClass<OpenAIBoundaryError>()(
  "OpenAIBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}
export interface RefreshOptions extends RefreshRequest {}
export interface OpenAIUsageServiceShape {
  readonly refresh: (options?: RefreshOptions) => Effect.Effect<void>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly updateSetting: (
    id: string,
    value: string,
  ) => Effect.Effect<void, OpenAIConfigError | InvalidSettingError>;
  readonly persistFast: (
    active: boolean,
    desiredActive: boolean,
    afterCommit?: Effect.Effect<void>,
  ) => Effect.Effect<void, OpenAIConfigError>;
  readonly reloadConfig: () => Effect.Effect<ResolvedConfig, OpenAIConfigError>;
  readonly readConfigDocument: () => Effect.Effect<JsonObject, OpenAIConfigError>;
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
      readonly credential?: CodexUsageResult["credential"];
    }
  | {
      readonly _tag: "Success";
      readonly notify: boolean;
      readonly fetchedAt: number;
      readonly result: CodexUsageResult;
    };
export class OpenAIUsageService extends Context.Service<
  OpenAIUsageService,
  OpenAIUsageServiceShape
>()("pi-better-openai/usage-controller/OpenAIUsageService") {
  static layer(options: {
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly cwd: string;
    readonly projection: MutableRef.MutableRef<OpenAIProjection>;
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
        const tracer = yield* Tracer.Tracer;
        const provideDependencies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(JsonDocumentStore, documents),
            Effect.provideService(JsonHttpClient, http),
            Effect.provideService(Tracer.Tracer, tracer),
          );
        const agentDir = options.agentDir ?? (yield* AgentDirectory);
        const authPath = path.join(agentDir, "auth.json");
        const projectTrusted = options.projectTrusted ?? true;
        const config = yield* resolveConfig(cwd, agentDir, projectTrusted);
        const state = yield* makeFrozenProjection<OpenAIProjection, OpenAIProjection>(
          { ...initial(), config, authPath },
          (current) => current,
          (published) => MutableRef.set(projection, published),
        );
        const configMutation = yield* Semaphore.make(1);
        const updateState = (f: (current: OpenAIProjection) => OpenAIProjection) =>
          state
            .transition((current) => {
              const next = f(current);
              return Effect.succeed([next, next] as const);
            })
            .pipe(Effect.orDie);
        const notifyChanged = Effect.try({
          try: onChange,
          catch: () =>
            new OpenAIBoundaryError({
              operation: "render",
              message: "Unable to update Better OpenAI UI.",
            }),
        }).pipe(Effect.catch(() => Effect.void));
        const notifyUser = (message: string, level: "info" | "warning") =>
          Effect.try({
            try: () => MutableRef.get(context).ui.notify(message, level),
            catch: () =>
              new OpenAIBoundaryError({
                operation: "notify",
                message: "Unable to notify Better OpenAI status.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        const synchronize = (clearUsage = false) =>
          updateState((current) =>
            synchronizedProjection(current, MutableRef.get(context), clearUsage),
          ).pipe(Effect.asVoid);
        yield* synchronize(true);
        const key = Effect.gen(function* () {
          const ctx = MutableRef.get(context);
          const current = yield* state.getState;
          return `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}:${usageScopeForModel(ctx.model?.id)}:${current.config?.usage.enabled ?? false}:${current.config?.usage.showOnlyOnSubscriptionModels ?? true}`;
        });
        const refreshEngine = yield* makeSubscriptionRefresh<
          RefreshOptions,
          string,
          RefreshValue,
          never,
          Path.Path | JsonDocumentStore | JsonHttpClient
        >({
          mergeRequest: (current, next) => ({
            force: current?.force === true || next.force === true,
            notify: current?.notify === true || next.notify === true,
          }),
          currentKey: key,
          interval: state.getState.pipe(
            Effect.map((current) => current.config?.usage.refreshIntervalMs ?? 60_000),
          ),
          fetch: (request) =>
            Effect.gen(function* () {
              const ctx = MutableRef.get(context);
              const current = yield* state.getState;
              const cfg = current.config;
              if (!cfg || !ctx.hasUI) return { _tag: "Skipped" } as const;
              const now = yield* Clock.currentTimeMillis;
              if (!cfg.usage.enabled)
                return { _tag: "Disabled", notify: request.notify === true } as const;
              if (!isOpenAISubscriptionModel(ctx, cfg))
                return { _tag: "Hidden", notify: request.notify === true } as const;
              if (
                !request.force &&
                !request.notify &&
                current.lastFetchAt !== undefined &&
                now - current.lastFetchAt < cfg.usage.refreshIntervalMs
              )
                return { _tag: "Skipped" } as const;
              const authOutcome = yield* getCodexCredentialsResult(authPath, ctx).pipe(
                Effect.timeout("10 seconds"),
                Effect.result,
              );
              if (authOutcome._tag === "Failure")
                return {
                  _tag: "Failure",
                  notify: request.notify === true,
                  fetchedAt: now,
                  message: "Codex credential lookup timed out.",
                } as const;
              const authResult = authOutcome.success;
              if (authResult._tag === "Missing")
                return {
                  _tag: "Missing",
                  notify: request.notify === true,
                  fetchedAt: now,
                } as const;
              if (authResult._tag !== "Found")
                return {
                  _tag: "Failure",
                  notify: request.notify === true,
                  fetchedAt: now,
                  message: sanitizeDiagnosticError(authResult.message),
                } as const;
              const usage = yield* requestCodexUsageWithCredentials(
                authResult.credentials,
                ctx.model?.id,
              ).pipe(Effect.timeout("10 seconds"), Effect.result);
              if (usage._tag === "Failure")
                return {
                  _tag: "Failure",
                  notify: request.notify === true,
                  fetchedAt: now,
                  message: sanitizeDiagnosticError(
                    typeof usage.failure.message === "string"
                      ? usage.failure.message
                      : "Codex usage request timed out.",
                  ),
                  credential: {
                    source: authResult.credentials.source,
                    accountId: authResult.credentials.accountId,
                  },
                } as const;
              return {
                _tag: "Success",
                notify: request.notify === true,
                fetchedAt: now,
                result: usage.success,
              } as const;
            }),
          commit: (value) =>
            Effect.gen(function* () {
              if (value._tag === "Skipped") return;
              if (value._tag === "Failure")
                yield* Effect.logWarning("Better OpenAI usage recovery: refresh_failed.");
              if (value._tag === "Missing")
                yield* Effect.logWarning("Better OpenAI usage recovery: credentials_missing.");
              const latest = yield* updateState((current) => {
                const cfg = current.config!;
                const attempted =
                  "fetchedAt" in value
                    ? {
                        ...current,
                        eligible: true,
                        error: undefined,
                        lastFetchAt: value.fetchedAt,
                      }
                    : current;
                if (value._tag === "Disabled")
                  return {
                    ...attempted,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText: "Usage display is disabled.",
                  };
                if (value._tag === "Hidden")
                  return {
                    ...attempted,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText: "Usage hidden: current model is not an OpenAI subscription model.",
                  };
                if (value._tag === "Failure")
                  return {
                    ...attempted,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: value.message,
                    statusText: `Usage unavailable: ${value.message}`,
                    ...(value.credential
                      ? {
                          authFound: true,
                          authSource: value.credential.source,
                          accountId: value.credential.accountId,
                        }
                      : {}),
                  };
                if (value._tag === "Missing") {
                  const message = `Missing openai-codex OAuth credentials in ${authPath}. Run /login openai-codex.`;
                  return {
                    ...attempted,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: message,
                    statusText: `Usage unavailable: ${message}`,
                    authFound: false,
                    authSource: undefined,
                    accountId: undefined,
                  };
                }
                const { snapshot, credential } = value.result;
                return {
                  ...attempted,
                  eligible: true,
                  snapshot,
                  statusLine: formatUsageSnapshot(snapshot, cfg.usage, value.fetchedAt),
                  statusText: formatUsageDetails(snapshot, value.fetchedAt),
                  error: undefined,
                  updatedAt: value.fetchedAt,
                  authFound: true,
                  authSource: credential.source,
                  accountId: credential.accountId,
                };
              });
              yield* notifyChanged;
              if ("notify" in value && value.notify)
                yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
            }),
          spanName: "pi-better-openai.usage.refresh",
        });
        const refresh = (request: RefreshOptions = {}) =>
          provideDependencies(refreshEngine.request(request));
        const contextChanged = (clearUsage = false) =>
          synchronize(clearUsage).pipe(Effect.andThen(refreshEngine.invalidate), Effect.asVoid);
        const reloadConfigWithRequirements = Effect.fn("OpenAIUsage.reloadConfig")(function* () {
          const current = yield* state.getState;
          const next = yield* resolveConfig(cwd, agentDir, projectTrusted);
          const clearUsage = current.config ? usageConfigChanged(current.config, next) : true;
          yield* updateState((current) => ({ ...current, config: next }));
          yield* synchronize(clearUsage);
          return next;
        });
        const reloadConfig = () =>
          provideDependencies(configMutation.withPermit(reloadConfigWithRequirements()));
        const readGlobalFallback = Effect.fn("OpenAIUsage.readGlobalFallback")(function* (
          current: ResolvedConfig,
        ) {
          if (current.configPath !== current.projectConfigPath || !current.globalConfigExists)
            return undefined;
          return yield* readRawConfig(current.globalConfigPath).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );
        });
        const updateSettingWithRequirements = Effect.fn("OpenAIUsage.updateSetting")(function* (
          id: string,
          value: string,
        ) {
          const update = yield* prepareSettingUpdate(id, value);
          yield* configMutation.withPermit(
            Effect.gen(function* () {
              const freshConfig = yield* resolveConfig(cwd, agentDir, projectTrusted);
              const globalFallback = yield* readGlobalFallback(freshConfig);
              yield* modifyConfig(freshConfig.configPath, (raw) => {
                const committed = update(raw);
                const nextConfig = resolveCommittedConfig(freshConfig, committed, globalFallback);
                return {
                  value: nextConfig,
                  document: committed,
                  afterCommit: updateState((latest) => ({ ...latest, config: nextConfig })).pipe(
                    Effect.andThen(synchronize(true)),
                  ),
                };
              }).pipe(Effect.provideService(JsonDocumentStore, documents));
            }),
          );
          yield* refreshEngine.invalidate;
          yield* refresh({ force: true });
        });
        const updateSetting = (id: string, value: string) =>
          provideDependencies(updateSettingWithRequirements(id, value));
        const persistFastWithRequirements = Effect.fn("OpenAIUsage.persistFast")(function* (
          active: boolean,
          desiredActive: boolean,
          afterCommit: Effect.Effect<void> = Effect.void,
        ) {
          yield* configMutation.withPermit(
            Effect.gen(function* () {
              const freshConfig = yield* resolveConfig(cwd, agentDir, projectTrusted);
              if (!freshConfig.persistState) {
                yield* Effect.uninterruptible(afterCommit);
                return;
              }
              const globalFallback = yield* readGlobalFallback(freshConfig);
              yield* modifyConfig(freshConfig.configPath, (raw) => {
                const committed = { ...raw, active, desiredActive };
                const nextConfig = resolveCommittedConfig(freshConfig, committed, globalFallback);
                const clearUsage = usageConfigChanged(freshConfig, nextConfig);
                return {
                  value: nextConfig,
                  document: committed,
                  afterCommit: updateState((latest) => ({ ...latest, config: nextConfig })).pipe(
                    Effect.andThen(synchronize(clearUsage)),
                    Effect.andThen(afterCommit),
                  ),
                };
              }).pipe(Effect.provideService(JsonDocumentStore, documents));
            }),
          );
        });
        const persistFast = (
          active: boolean,
          desiredActive: boolean,
          afterCommit?: Effect.Effect<void>,
        ) =>
          provideDependencies(
            persistFastWithRequirements(active, desiredActive, afterCommit ?? Effect.void),
          );
        const readConfigDocument = () =>
          state.getState.pipe(
            Effect.flatMap((current) =>
              current.config
                ? readRawConfig(current.config.configPath).pipe(
                    Effect.provideService(JsonDocumentStore, documents),
                  )
                : Effect.succeed({}),
            ),
          );
        if (options.startPolling !== false) {
          yield* Effect.gen(function* () {
            yield* refresh({ force: true });
            yield* provideDependencies(refreshEngine.startPolling({}));
          }).pipe(Effect.forkScoped);
        }
        return OpenAIUsageService.of({
          refresh,
          contextChanged,
          updateSetting,
          persistFast,
          reloadConfig,
          readConfigDocument,
        });
      }).pipe(Effect.withSpan("pi-better-openai.usage.initialize")),
    );
  }
}

export function formatStatus(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  now: number,
): string {
  const state = MutableRef.get(projection);
  if (!state.config?.usage.enabled) return "Usage display is disabled.";
  if (!state.eligible) return "Usage hidden: current model is not an OpenAI subscription model.";
  if (state.error) return `Usage unavailable: ${state.error}`;
  if (!state.snapshot) return state.statusText;
  const stale =
    state.updatedAt !== undefined &&
    now - state.updatedAt > state.config.usage.refreshIntervalMs * 2
      ? ` | stale ${formatResetCountdown((now - state.updatedAt) / 1000)}`
      : "";
  return `${formatUsageDetails(state.snapshot, now)}${stale}`;
}
export function formatDebug(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  const time = (value: number | undefined) =>
    value === undefined ? "never" : DateTime.formatLocal(DateTime.makeUnsafe(value));
  return [
    `Usage enabled: ${cfg?.usage.enabled ?? false}`,
    `Current model: ${currentModelKey(ctx)}`,
    `Current model eligible: ${cfg ? isOpenAISubscriptionModel(ctx, cfg) : false}`,
    `Requires subscription model: ${cfg?.usage.showOnlyOnSubscriptionModels ?? true}`,
    `Auth: ${state.authFound ? `found (${state.authSource ?? "unknown"})` : "missing"}`,
    `Account ID: ${maskIdentifier(state.accountId) ?? "none"}`,
    `Last fetch: ${time(state.lastFetchAt)}`,
    `Last successful update: ${time(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${cfg?.usage.refreshIntervalMs ?? 60_000}ms`,
    `Endpoint: ${USAGE_URL}`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}
