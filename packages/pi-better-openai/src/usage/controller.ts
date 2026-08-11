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
  type JsonObject,
  makeFrozenProjection,
  mergeRefreshRequest,
  makeSubscriptionRefresh,
  sanitizeDiagnosticError,
  type RefreshRequest,
} from "pi-cosmic-core";
import { ignoreHostUi } from "../boundary/host-ui.ts";
import type { ResolvedConfig } from "../config/index.ts";
import {
  modifyConfig,
  prepareSettingUpdate,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  type InvalidSettingError,
  type OpenAIConfigError,
} from "../config/index.ts";
import { getCodexCredentialsResult } from "../auth/codex-auth.ts";
import {
  initialProjection,
  isOpenAISubscriptionModel,
  synchronizedProjection,
  usageConfigChanged,
  type OpenAIProjection,
} from "./projection.ts";
import {
  type CodexUsageResult,
  formatUsageDetails,
  formatUsageSnapshot,
  requestCodexUsageWithCredentials,
  usageScopeForModel,
} from "./format.ts";

export class OpenAIBoundaryError extends Schema.TaggedErrorClass<OpenAIBoundaryError>()(
  "OpenAIBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}
export type RefreshOptions = RefreshRequest;
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
>()("pi-better-openai/usage/controller/OpenAIUsageService") {
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
          { ...initialProjection(), config, authPath },
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
        const notifyChanged = ignoreHostUi("usage.render", onChange);
        const notifyUser = (message: string, level: "info" | "warning") =>
          ignoreHostUi("usage.notify", () => MutableRef.get(context).ui.notify(message, level));
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
              if (!cfg || !ctx.hasUI) return { _tag: "Skipped" } as const;
              const now = yield* Clock.currentTimeMillis;
              if (!cfg.usage.enabled) return { _tag: "Disabled", notify } as const;
              if (!isOpenAISubscriptionModel(ctx, cfg)) return { _tag: "Hidden", notify } as const;
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
                  notify,
                  fetchedAt: now,
                  message: "Codex credential lookup timed out.",
                } as const;
              const authResult = authOutcome.success;
              if (authResult._tag === "Missing")
                return { _tag: "Missing", notify, fetchedAt: now } as const;
              if (authResult._tag !== "Found")
                return {
                  _tag: "Failure",
                  notify,
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
                  notify,
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
              return { _tag: "Success", notify, fetchedAt: now, result: usage.success } as const;
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
                if (value._tag === "Disabled" || value._tag === "Hidden")
                  return {
                    ...attempted,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText:
                      value._tag === "Disabled"
                        ? "Usage display is disabled."
                        : "Usage hidden: current model is not an OpenAI subscription model.",
                  };
                if (value._tag === "Failure" || value._tag === "Missing") {
                  const message =
                    value._tag === "Missing"
                      ? `Missing openai-codex OAuth credentials in ${authPath}. Run /login openai-codex.`
                      : value.message;
                  return {
                    ...attempted,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: message,
                    statusText: `Usage unavailable: ${message}`,
                    ...(value._tag === "Missing"
                      ? { authFound: false, authSource: undefined, accountId: undefined }
                      : value.credential
                        ? {
                            authFound: true,
                            authSource: value.credential.source,
                            accountId: value.credential.accountId,
                          }
                        : {}),
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
          readConfigDocument,
        });
      }).pipe(Effect.withSpan("pi-better-openai.usage.initialize")),
    );
  }
}
