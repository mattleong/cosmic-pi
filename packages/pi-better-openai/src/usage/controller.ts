import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type JsonObject,
  InvalidSettingError,
  makeUsageRefreshController,
  timedDiagnosticResult,
} from "pi-cosmic-core";
import { getCodexCredentials } from "../auth/codex-auth.ts";
import { prepareSettingUpdate } from "../config/options.ts";
import { HIDDEN_USAGE_STATUS_TEXT } from "./projection.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import {
  modifyConfig,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  type OpenAIConfigError,
} from "../config/store.ts";
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
interface OpenAIUsageServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly onChange: () => void;
  readonly startPolling?: boolean;
  readonly isUsageVisible?: () => boolean;
  readonly agentDir?: string;
  readonly projectTrusted?: boolean;
}

export class OpenAIUsageService extends Context.Service<OpenAIUsageService>()(
  "pi-better-openai/usage/controller/OpenAIUsageService",
  {
    make: Effect.fnUntraced(function* (options: OpenAIUsageServiceOptions) {
      const { cwd } = options;
      const projectTrusted = options.projectTrusted === true;
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
        backgroundEnabled: options.isUsageVisible,
        agentDir: options.agentDir,
        projectTrusted: options.projectTrusted,
        initialProjection,
        hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
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
            const authAttempt = yield* timedDiagnosticResult(
              getCodexCredentials(authPath, ctx),
              "Codex credential lookup timed out.",
            );
            if (Result.isFailure(authAttempt))
              return { _tag: "Failure", message: authAttempt.failure } as const;
            const credentials = authAttempt.success;
            if (credentials === undefined) return { _tag: "Missing" } as const;
            const authPatch = {
              authFound: true,
              authSource: credentials.source,
              accountId: credentials.accountId,
            } as const;
            const usage = yield* timedDiagnosticResult(
              requestCodexUsageWithCredentials(credentials, ctx.model?.id),
              "Codex usage request timed out.",
            );
            if (Result.isFailure(usage))
              return {
                _tag: "Failure",
                message: usage.failure,
                patch: authPatch,
              } as const;
            return {
              _tag: "Success",
              snapshot: usage.success,
              patch: authPatch,
            } as const;
          }),
        formatStatusLine: (snapshot, cfg, fetchedAt) =>
          formatUsageSnapshot(snapshot, cfg.usage, fetchedAt),
        formatStatusText: formatUsageDetails,
        dependencies: Context.empty(),
      });
      const persistFastWithRequirements = Effect.fn("OpenAIUsage.persistFast")(function* (
        active: boolean,
        desiredActive: boolean,
        afterCommit: Effect.Effect<void>,
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
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const readConfigDocument = () =>
        controller.getState.pipe(
          Effect.flatMap((current) =>
            current.config
              ? controller.provideDependencies(readRawConfig(current.config.configPath))
              : Effect.succeed({} as JsonObject),
          ),
        );
      return {
        refresh: controller.refresh,
        contextChanged: controller.contextChanged,
        updateSetting: controller.updateSetting,
        persistFast,
        readConfigDocument,
      };
    }, Effect.withSpan("pi-better-openai.usage.initialize")),
  },
) {
  static layer(options: OpenAIUsageServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
