import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  commitPreferredScope,
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
export const sessionNotStarted = (operation = "runtime") =>
  new OpenAIBoundaryError({ operation, message: "Better OpenAI session has not started." });
interface OpenAIUsageServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly onChange: () => void;
  readonly canPublish?: () => boolean;
  readonly startPolling?: boolean;
  readonly isUsageVisible?: () => boolean;
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
        canPublish: options.canPublish,
        startPolling: options.startPolling,
        backgroundEnabled: options.isUsageVisible,
        projectTrusted: options.projectTrusted,
        initialProjection,
        hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
        missingCredentialsMessage: "Sign in with /login openai-codex",
        clearAuthPatch: { authFound: false, accountId: undefined },
        store: { resolveConfig, readRawConfig, resolveCommittedConfig, modifyConfig },
        decodeSettingUpdate: prepareSettingUpdate,
        eligibility: (ctx, cfg) => Effect.succeed(isOpenAISubscriptionModel(ctx, cfg)),
        synchronizeState: (current, ctx, clearUsage) =>
          Effect.succeed(synchronizedProjection(current, ctx, clearUsage)),
        refreshKeyScope: (ctx) => usageScopeForModel(ctx.model?.id),
        fetchOutcome: ({ ctx }) =>
          Effect.gen(function* () {
            const authAttempt = yield* timedDiagnosticResult(
              getCodexCredentials(ctx),
              "Codex credential lookup timed out.",
            );
            if (Result.isFailure(authAttempt))
              return { _tag: "Failure", message: authAttempt.failure } as const;
            const credentials = authAttempt.success;
            if (credentials === undefined) return { _tag: "Missing" } as const;
            const authPatch = { authFound: true, accountId: credentials.accountId } as const;
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
      const persistFast = Effect.fn("OpenAIUsage.persistFast")(
        function* (active: boolean, desiredActive: boolean, afterCommit: Effect.Effect<void>) {
          yield* controller.withSettingsPermit(
            Effect.gen(function* () {
              const freshConfig = yield* resolveConfig(cwd, controller.agentDir, projectTrusted);
              if (!freshConfig.persistState) {
                yield* Effect.uninterruptible(afterCommit);
                return;
              }
              yield* commitPreferredScope(
                { readRawConfig, modifyConfig, resolveCommittedConfig },
                freshConfig,
                (raw) => ({ ...raw, active, desiredActive }),
                (nextConfig) =>
                  // Changed usage settings invalidate pending results and wake polling. A
                  // fast-only write leaves both alone: an in-flight usage result is still current,
                  // though eligibility follows any usage settings changed outside this session.
                  (usageConfigChanged(freshConfig, nextConfig)
                    ? controller.installConfig(nextConfig)
                    : controller.updateState((current) =>
                        synchronizedProjection(
                          { ...current, config: nextConfig },
                          MutableRef.get(options.context),
                          false,
                        ),
                      )
                  ).pipe(Effect.andThen(afterCommit)),
              );
            }),
          );
        },
        (effect) => controller.provideDependencies(effect),
      );
      const readConfigDocument = controller.getState.pipe(
        Effect.flatMap((current) =>
          current.config
            ? controller.provideDependencies(readRawConfig(current.config.configPath))
            : Effect.succeed<JsonObject>({}),
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
