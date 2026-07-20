import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  JsonHttpClient,
  type JsonObject,
  makeRefreshCoordinator,
  type RefreshRequest,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "./config.ts";
import {
  applySettingToRawConfig,
  readRawConfig,
  resolveConfig,
  updateConfig,
  type OpenAIConfigError,
} from "./config.ts";
import { currentModelKey } from "./fast-controller.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { getCodexCredentials, type CodexCredentialsWithSource } from "./codex-auth.ts";
import {
  USAGE_URL,
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
  readonly updateSetting: (id: string, value: string) => Effect.Effect<void, OpenAIConfigError>;
  readonly persistFast: (
    active: boolean,
    desiredActive: boolean,
  ) => Effect.Effect<void, OpenAIConfigError>;
  readonly reloadConfig: () => Effect.Effect<ResolvedConfig, OpenAIConfigError>;
  readonly readConfigDocument: () => Effect.Effect<JsonObject, OpenAIConfigError>;
}

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
        const documents = yield* JsonDocumentStore;
        const http = yield* JsonHttpClient;
        const agentDir = options.agentDir ?? getAgentDir();
        const authPath = path.join(agentDir, "auth.json");
        const coordinator = yield* makeRefreshCoordinator();
        const initialPollingWake = yield* Deferred.make<void>();
        const pollingWake = MutableRef.make(initialPollingWake);
        const resolveCurrentConfig = () =>
          resolveConfig(cwd, agentDir).pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(JsonDocumentStore, documents),
          );
        const updateCurrentConfig = (
          configPath: string,
          update: (raw: Record<string, unknown>) => Record<string, unknown>,
        ) =>
          updateConfig(configPath, update).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );
        const resolveCurrentCredentials = (ctx: ExtensionContext) =>
          getCodexCredentials(authPath, ctx).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );
        const requestCurrentUsage = (
          credentials: CodexCredentialsWithSource,
          modelId: string | undefined,
        ) =>
          requestCodexUsageWithCredentials(credentials, modelId).pipe(
            Effect.provideService(JsonHttpClient, http),
          );
        const wakePolling = Effect.fn("OpenAIUsage.wakePolling")(function* () {
          const next = yield* Deferred.make<void>();
          const previous = MutableRef.get(pollingWake);
          MutableRef.set(pollingWake, next);
          yield* Deferred.succeed(previous, undefined);
        });
        const config = yield* resolveCurrentConfig();
        MutableRef.set(projection, { ...MutableRef.get(projection), config, authPath });
        synchronizeProjectionContext(projection, MutableRef.get(context));

        const notifyChanged = Effect.fn("OpenAIUsage.notifyChanged")(function* () {
          yield* Effect.try({
            try: onChange,
            catch: () =>
              new OpenAIBoundaryError({
                operation: "render",
                message: "Unable to update Better OpenAI UI.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        });
        const notifyUser = Effect.fn("OpenAIUsage.notifyUser")(function* (
          message: string,
          level: "info" | "warning",
        ) {
          const ctx = MutableRef.get(context);
          yield* Effect.try({
            try: () => ctx.ui.notify(message, level),
            catch: () =>
              new OpenAIBoundaryError({
                operation: "notify",
                message: "Unable to notify Better OpenAI status.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        });
        const refreshOnce = Effect.fn("OpenAIUsage.refreshOnce")(function* (
          request: RefreshRequest,
        ) {
          const ctx = MutableRef.get(context);
          const current = MutableRef.get(projection);
          const cfg = current.config;
          if (!cfg || !ctx.hasUI) return;
          const now = yield* Clock.currentTimeMillis;
          if (!cfg.usage.enabled) {
            MutableRef.set(projection, {
              ...current,
              eligible: false,
              snapshot: undefined,
              statusLine: undefined,
              error: undefined,
              statusText: "Usage display is disabled.",
            });
            yield* notifyChanged();
            if (request.notify) yield* notifyUser("Usage display is disabled.", "warning");
            return;
          }
          if (!isOpenAISubscriptionModel(ctx, cfg)) {
            const statusText = "Usage hidden: current model is not an OpenAI subscription model.";
            MutableRef.set(projection, {
              ...current,
              eligible: false,
              snapshot: undefined,
              statusLine: undefined,
              error: undefined,
              statusText,
            });
            yield* notifyChanged();
            if (request.notify) yield* notifyUser(statusText, "warning");
            return;
          }
          if (
            !request.force &&
            !request.notify &&
            current.lastFetchAt !== undefined &&
            now - current.lastFetchAt < cfg.usage.refreshIntervalMs
          )
            return;
          MutableRef.set(projection, {
            ...current,
            eligible: true,
            error: undefined,
            lastFetchAt: now,
          });
          const usageResult = yield* Effect.gen(function* () {
            const credentials = yield* resolveCurrentCredentials(ctx);
            if (!credentials) return undefined;
            const beforeRequest = MutableRef.get(projection);
            MutableRef.set(projection, {
              ...beforeRequest,
              authFound: true,
              authSource: credentials.source,
              accountId: credentials.accountId,
            });
            return yield* requestCurrentUsage(credentials, ctx.model?.id);
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch((error) => {
              const message = sanitizeDiagnosticError(
                typeof error.message === "string"
                  ? error.message
                  : "Codex usage request timed out.",
              );
              const failed = MutableRef.get(projection);
              MutableRef.set(projection, {
                ...failed,
                snapshot: undefined,
                statusLine: undefined,
                error: message,
                statusText: `Usage unavailable: ${message}`,
              });
              return Effect.void;
            }),
          );
          const refreshedAt = yield* Clock.currentTimeMillis;
          const next = MutableRef.get(projection);
          if (usageResult) {
            const { snapshot, credential } = usageResult;
            MutableRef.set(projection, {
              ...next,
              eligible: true,
              snapshot,
              statusLine: formatUsageSnapshot(snapshot, cfg.usage, refreshedAt),
              statusText: formatUsageDetails(snapshot, refreshedAt),
              error: undefined,
              updatedAt: refreshedAt,
              authFound: true,
              authSource: credential.source,
              accountId: credential.accountId,
            });
          } else if (!MutableRef.get(projection).error) {
            const missing = `Missing openai-codex OAuth credentials in ${authPath}. Run /login openai-codex.`;
            MutableRef.set(projection, {
              ...next,
              snapshot: undefined,
              statusLine: undefined,
              error: missing,
              statusText: `Usage unavailable: ${missing}`,
              authFound: false,
              authSource: undefined,
              accountId: undefined,
            });
          }
          yield* notifyChanged();
          if (request.notify) {
            const latest = MutableRef.get(projection);
            yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
          }
        });
        const refresh = (request: RefreshOptions = {}) => coordinator.run(request, refreshOnce);
        const reloadConfigWithRequirements = Effect.fn("OpenAIUsage.reloadConfig")(function* () {
          const next = yield* resolveCurrentConfig();
          MutableRef.set(projection, { ...MutableRef.get(projection), config: next });
          return next;
        });
        const reloadConfig = reloadConfigWithRequirements;
        const updateSettingWithRequirements = Effect.fn("OpenAIUsage.updateSetting")(function* (
          id: string,
          value: string,
        ) {
          const current = MutableRef.get(projection);
          if (!current.config) return;
          yield* updateCurrentConfig(current.config.configPath, (raw) =>
            applySettingToRawConfig(raw, id, value),
          );
          yield* reloadConfigWithRequirements();
          synchronizeProjectionContext(projection, MutableRef.get(context), { clearUsage: true });
          yield* refresh({ force: true });
          yield* wakePolling();
        });
        const updateSetting = updateSettingWithRequirements;
        const persistFastWithRequirements = Effect.fn("OpenAIUsage.persistFast")(function* (
          active: boolean,
          desiredActive: boolean,
        ) {
          const current = MutableRef.get(projection);
          if (!current.config?.persistState) return;
          yield* updateCurrentConfig(current.config.configPath, (raw) => ({
            ...raw,
            active,
            desiredActive,
          }));
          yield* reloadConfigWithRequirements();
        });
        const persistFast = persistFastWithRequirements;
        const readConfigDocument = () => {
          const configPath = MutableRef.get(projection).config?.configPath;
          return configPath
            ? readRawConfig(configPath).pipe(Effect.provideService(JsonDocumentStore, documents))
            : Effect.succeed({});
        };
        if (options.startPolling !== false) {
          yield* Effect.gen(function* () {
            yield* refresh({ force: true });
            while (true) {
              const wake = MutableRef.get(pollingWake);
              const interval = MutableRef.get(projection).config?.usage.refreshIntervalMs ?? 60_000;
              yield* Effect.raceFirst(Effect.sleep(interval), Deferred.await(wake));
              yield* refresh();
            }
          }).pipe(Effect.forkScoped);
        }
        return OpenAIUsageService.of({
          refresh,
          updateSetting,
          persistFast,
          reloadConfig,
          readConfigDocument,
        });
      }),
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
