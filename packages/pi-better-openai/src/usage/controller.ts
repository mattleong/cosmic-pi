import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import {
  JsonDocumentStore,
  JsonHttpClient,
  type JsonObject,
  makeUsageRefreshController,
  sanitizeDiagnosticError,
  type RefreshRequest,
} from "pi-cosmic-core";
import { getCodexCredentialsResult } from "../auth/codex-auth.ts";
import {
  modifyConfig,
  prepareSettingUpdate,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  type InvalidSettingError,
  type OpenAIConfigError,
  type ResolvedConfig,
} from "../config/index.ts";
import {
  formatUsageDetails,
  formatUsageSnapshot,
  requestCodexUsageWithCredentials,
  usageScopeForModel,
  type UsageSnapshot,
} from "./format.ts";
import {
  initialProjection,
  isOpenAISubscriptionModel,
  synchronizedProjection,
  usageConfigChanged,
  type OpenAIProjection,
} from "./projection.ts";

export class OpenAIBoundaryError extends Schema.TaggedError<OpenAIBoundaryError>()(
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
        const { cwd } = options;
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
        const projectTrusted = options.projectTrusted ?? true;
        const controller = yield* makeUsageRefreshController<
          OpenAIProjection,
          ResolvedConfig,
          UsageSnapshot,
          OpenAIConfigError,
          InvalidSettingError
        >({
          spanPrefix: "pi-better-openai.usage",
          logLabel: "Better OpenAI",
          context: options.context,
          cwd,
          projection: options.projection,
          onChange: options.onChange,
          startPolling: options.startPolling,
          agentDir: options.agentDir,
          projectTrusted: options.projectTrusted,
          initialProjection,
          hiddenStatusText: "Usage hidden: current model is not an OpenAI subscription model.",
          missingCredentialsMessage: (authPath) =>
            `Missing openai-codex OAuth credentials in ${authPath}. Run /login openai-codex.`,
          clearAuthPatch: { authFound: false, authSource: undefined, accountId: undefined },
          store: { resolveConfig, readRawConfig, resolveCommittedConfig, modifyConfig },
          decodeSettingUpdate: prepareSettingUpdate,
          eligibility: (ctx, cfg) => Effect.succeed(isOpenAISubscriptionModel(ctx, cfg)),
          synchronizeState: (current, ctx, clearUsage) =>
            Effect.succeed(synchronizedProjection(current, ctx, clearUsage)),
          refreshKeyScope: (ctx) => usageScopeForModel(ctx.model?.id),
          fetchOutcome: ({ ctx, authPath }) =>
            Effect.gen(function* () {
              const authOutcome = yield* getCodexCredentialsResult(authPath, ctx).pipe(
                Effect.timeout("10 seconds"),
                Effect.result,
              );
              if (authOutcome._tag === "Failure")
                return { _tag: "Failure", message: "Codex credential lookup timed out." } as const;
              const authResult = authOutcome.success;
              if (authResult._tag === "Missing") return { _tag: "Missing" } as const;
              if (authResult._tag !== "Found")
                return {
                  _tag: "Failure",
                  message: sanitizeDiagnosticError(authResult.message),
                } as const;
              const usage = yield* requestCodexUsageWithCredentials(
                authResult.credentials,
                ctx.model?.id,
              ).pipe(Effect.timeout("10 seconds"), Effect.result);
              if (usage._tag === "Failure")
                return {
                  _tag: "Failure",
                  message: sanitizeDiagnosticError(
                    typeof usage.failure.message === "string"
                      ? usage.failure.message
                      : "Codex usage request timed out.",
                  ),
                  patch: {
                    authFound: true,
                    authSource: authResult.credentials.source,
                    accountId: authResult.credentials.accountId,
                  },
                } as const;
              const { snapshot, credential } = usage.success;
              return {
                _tag: "Success",
                snapshot,
                patch: {
                  authFound: true,
                  authSource: credential.source,
                  accountId: credential.accountId,
                },
              } as const;
            }),
          formatStatusLine: (snapshot, cfg, fetchedAt) =>
            formatUsageSnapshot(snapshot, cfg.usage, fetchedAt),
          formatStatusText: formatUsageDetails,
          provideDependencies,
        });
        const persistFastWithRequirements = Effect.fn("OpenAIUsage.persistFast")(function* (
          active: boolean,
          desiredActive: boolean,
          afterCommit: Effect.Effect<void> = Effect.void,
        ) {
          yield* controller.withSettingsPermit(
            Effect.gen(function* () {
              const freshConfig = yield* resolveConfig(cwd, controller.agentDir, projectTrusted);
              if (!freshConfig.persistState) {
                yield* Effect.uninterruptible(afterCommit);
                return;
              }
              const globalFallback = yield* controller.readGlobalFallback(freshConfig);
              yield* modifyConfig(freshConfig.configPath, (raw) => {
                const committed = { ...raw, active, desiredActive };
                const nextConfig = resolveCommittedConfig(freshConfig, committed, globalFallback);
                const clearUsage = usageConfigChanged(freshConfig, nextConfig);
                return {
                  value: nextConfig,
                  document: committed,
                  afterCommit: controller
                    .updateState((latest) => ({ ...latest, config: nextConfig }))
                    .pipe(
                      Effect.andThen(controller.synchronize(clearUsage)),
                      Effect.andThen(afterCommit),
                    ),
                };
              });
            }),
          );
        });
        const persistFast = (
          active: boolean,
          desiredActive: boolean,
          afterCommit?: Effect.Effect<void>,
        ) =>
          controller.provideDependencies(
            persistFastWithRequirements(active, desiredActive, afterCommit ?? Effect.void),
          );
        const readConfigDocument = () =>
          controller.getState.pipe(
            Effect.flatMap((current) =>
              current.config
                ? controller.provideDependencies(readRawConfig(current.config.configPath))
                : Effect.succeed({} as JsonObject),
            ),
          );
        return OpenAIUsageService.of({
          refresh: controller.refresh,
          contextChanged: controller.contextChanged,
          updateSetting: controller.updateSetting,
          persistFast,
          readConfigDocument,
        });
      }).pipe(Effect.withSpan("pi-better-openai.usage.initialize")),
    );
  }
}
