import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  AgentDirectory,
  JsonDocumentStore,
  JsonHttpClient,
  type JsonObject,
  makeSubscriptionRefresh,
  type RefreshRequest,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "./config.ts";
import {
  applySettingToRawConfig,
  readRawConfig,
  resolveConfig,
  updateConfig,
  type InvalidSettingError,
  type OpenAIConfigError,
} from "./config.ts";
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
export const makeProjection = () => MutableRef.make(initial());
export const resetProjection = (projection: MutableRef.MutableRef<OpenAIProjection>): void => {
  MutableRef.set(projection, initial());
};

export function isOpenAISubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    (isUsingOAuth ?? ctx.modelRegistry.isUsingOAuth(model))
  );
}
export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  const state = MutableRef.get(projection);
  const eligible = state.config ? isOpenAISubscriptionModel(ctx, state.config) : false;
  const scopeMatches = state.snapshot?.scope === usageScopeForModel(ctx.model?.id);
  const statusText = eligible
    ? "Usage unavailable."
    : "Usage hidden: current model is not an OpenAI subscription model.";
  MutableRef.set(projection, {
    ...state,
    eligible,
    ...(options.clearUsage || !scopeMatches
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
  });
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
const freezeProjection = (state: OpenAIProjection): OpenAIProjection => Object.freeze({ ...state });

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
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const { context, cwd, projection, onChange } = options;
        const path = yield* Path.Path;
        const dependencies = yield* Effect.context<
          Path.Path | JsonDocumentStore | JsonHttpClient
        >();
        const documents = yield* JsonDocumentStore;
        const agentDir = options.agentDir ?? (yield* AgentDirectory);
        const authPath = path.join(agentDir, "auth.json");
        const config = yield* resolveConfig(cwd, agentDir);
        const state = yield* SynchronizedRef.make<OpenAIProjection>({
          ...initial(),
          config,
          authPath,
        });
        const publish = (next: OpenAIProjection) =>
          Effect.sync(() => MutableRef.set(projection, freezeProjection(next)));
        const updateState = (f: (current: OpenAIProjection) => OpenAIProjection) =>
          SynchronizedRef.modifyEffect(state, (current) => {
            const next = f(current);
            return publish(next).pipe(Effect.as([next, next] as const));
          });
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
          updateState((current) => {
            const ctx = MutableRef.get(context);
            const eligible = current.config
              ? isOpenAISubscriptionModel(ctx, current.config)
              : false;
            const scopeMatches = current.snapshot?.scope === usageScopeForModel(ctx.model?.id);
            const statusText = eligible
              ? "Usage unavailable."
              : "Usage hidden: current model is not an OpenAI subscription model.";
            return {
              ...current,
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
          }).pipe(Effect.asVoid);
        yield* synchronize(true);
        const key = Effect.gen(function* () {
          const ctx = MutableRef.get(context);
          const current = yield* SynchronizedRef.get(state);
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
          interval: SynchronizedRef.get(state).pipe(
            Effect.map((current) => current.config?.usage.refreshIntervalMs ?? 60_000),
          ),
          fetch: (request) =>
            Effect.gen(function* () {
              const ctx = MutableRef.get(context);
              const current = yield* SynchronizedRef.get(state);
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
              yield* updateState((latest) => ({
                ...latest,
                eligible: true,
                error: undefined,
                lastFetchAt: now,
              }));
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
              const latest = yield* updateState((current) => {
                const cfg = current.config!;
                if (value._tag === "Disabled")
                  return {
                    ...current,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText: "Usage display is disabled.",
                  };
                if (value._tag === "Hidden")
                  return {
                    ...current,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText: "Usage hidden: current model is not an OpenAI subscription model.",
                  };
                if (value._tag === "Failure")
                  return {
                    ...current,
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
                    ...current,
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
                  ...current,
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
          refreshEngine.request(request).pipe(Effect.provideContext(dependencies));
        const contextChanged = (clearUsage = false) =>
          synchronize(clearUsage).pipe(Effect.andThen(refreshEngine.invalidate), Effect.asVoid);
        const reloadConfigWithRequirements = Effect.fn("OpenAIUsage.reloadConfig")(function* () {
          const next = yield* resolveConfig(cwd, agentDir);
          yield* updateState((current) => ({ ...current, config: next }));
          return next;
        });
        const reloadConfig = () =>
          reloadConfigWithRequirements().pipe(Effect.provideContext(dependencies));
        const updateSettingWithRequirements = Effect.fn("OpenAIUsage.updateSetting")(function* (
          id: string,
          value: string,
        ) {
          const current = yield* SynchronizedRef.get(state);
          if (!current.config) return;
          const raw = yield* readRawConfig(current.config.configPath).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );
          const nextRaw = yield* applySettingToRawConfig(raw, id, value);
          yield* updateConfig(current.config.configPath, () => nextRaw).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );
          yield* reloadConfig();
          yield* synchronize(true);
          yield* refreshEngine.invalidate;
          yield* refresh({ force: true });
        });
        const updateSetting = (id: string, value: string) =>
          updateSettingWithRequirements(id, value).pipe(Effect.provideContext(dependencies));
        const persistFastWithRequirements = Effect.fn("OpenAIUsage.persistFast")(function* (
          active: boolean,
          desiredActive: boolean,
        ) {
          const current = yield* SynchronizedRef.get(state);
          if (!current.config?.persistState) return;
          yield* updateConfig(current.config.configPath, (raw) => ({
            ...raw,
            active,
            desiredActive,
          })).pipe(Effect.provideService(JsonDocumentStore, documents));
          yield* reloadConfig();
        });
        const persistFast = (active: boolean, desiredActive: boolean) =>
          persistFastWithRequirements(active, desiredActive).pipe(
            Effect.provideContext(dependencies),
          );
        const readConfigDocument = () =>
          SynchronizedRef.get(state).pipe(
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
            yield* refreshEngine.startPolling({}).pipe(Effect.provideContext(dependencies));
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
