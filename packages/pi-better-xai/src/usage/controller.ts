import * as Predicate from "effect/Predicate";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import {
  makeUsageRefreshController,
  sanitizeDiagnosticError,
  withUsageEligibility,
  type RefreshRequest,
  type UsageFetchOutcome,
} from "pi-cosmic-core";
import { ModelRegistryAuth } from "../boundary/model-registry-auth.ts";
import {
  decodeSettingUpdate,
  modifyConfig,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  type InvalidSettingError,
  type ResolvedConfig,
  type XaiConfigError,
} from "../config/index.ts";
import {
  formatUsageDetails,
  formatUsageSnapshot,
  requestXaiUsage,
  type UsageSnapshot,
} from "./format.ts";
import {
  HIDDEN_USAGE_STATUS_TEXT,
  initialXaiProjection,
  isXaiSubscriptionModel,
  type XaiProjection,
} from "./projection.ts";

export class XaiBoundaryError extends Schema.TaggedError<XaiBoundaryError>()("XaiBoundaryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type RefreshOptions = RefreshRequest;

export interface XaiUsageServiceContract {
  readonly refresh: (options?: RefreshOptions) => Effect.Effect<void>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly updateSetting: (
    id: string,
    value: string,
  ) => Effect.Effect<void, XaiConfigError | InvalidSettingError>;
}

export class XaiUsageService extends Context.Service<XaiUsageService, XaiUsageServiceContract>()(
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
    /** Owned domain seam for deterministic refresh/concurrency tests. */
    readonly requestUsage?: typeof requestXaiUsage;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const registryAuth = yield* ModelRegistryAuth;
        const requestUsage = options.requestUsage ?? requestXaiUsage;
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
        const controller = yield* makeUsageRefreshController<
          XaiProjection,
          ResolvedConfig,
          UsageSnapshot,
          XaiConfigError,
          InvalidSettingError,
          ModelRegistryAuth
        >({
          spanPrefix: "pi-better-xai.usage",
          logLabel: "Better xAI",
          context: options.context,
          cwd: options.cwd,
          projection: options.projection,
          onChange: options.onChange,
          startPolling: options.startPolling,
          agentDir: options.agentDir,
          projectTrusted: options.projectTrusted,
          initialProjection: initialXaiProjection,
          hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
          missingCredentialsMessage: (authPath) =>
            `Missing xAI OAuth credentials in ${authPath}. Run /login xai.`,
          clearAuthPatch: { authFound: false, teamId: undefined },
          store: { resolveConfig, readRawConfig, resolveCommittedConfig, modifyConfig },
          decodeSettingUpdate,
          eligibility: subscriptionEligibility,
          synchronizeState: (current, ctx, clearUsage) =>
            (current.config
              ? subscriptionEligibility(ctx, current.config)
              : Effect.succeed(false)
            ).pipe(
              Effect.map((eligible) =>
                withUsageEligibility(current, eligible, clearUsage, {
                  hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
                }),
              ),
            ),
          fetchOutcome: ({ authPath }) =>
            requestUsage(authPath).pipe(
              Effect.timeout("10 seconds"),
              Effect.result,
              Effect.map((result): UsageFetchOutcome<UsageSnapshot, Partial<XaiProjection>> => {
                if (result._tag === "Failure")
                  return {
                    _tag: "Failure",
                    message: sanitizeDiagnosticError(
                      Predicate.isString(result.failure.message)
                        ? result.failure.message
                        : "xAI usage request timed out.",
                    ),
                  };
                if (!result.success) return { _tag: "Missing" };
                return {
                  _tag: "Success",
                  snapshot: result.success.snapshot,
                  patch: { authFound: true, teamId: result.success.teamId },
                };
              }),
            ),
          formatStatusLine: (snapshot, cfg, fetchedAt) =>
            formatUsageSnapshot(snapshot, cfg.usage, fetchedAt),
          formatStatusText: formatUsageDetails,
          dependencies: Context.make(ModelRegistryAuth, registryAuth),
        });
        return XaiUsageService.of({
          refresh: controller.refresh,
          contextChanged: controller.contextChanged,
          updateSetting: controller.updateSetting,
        });
      }).pipe(Effect.withSpan("pi-better-xai.usage.initialize")),
    ).pipe(
      Layer.provide(ModelRegistryAuth.layer(() => MutableRef.get(options.context).modelRegistry)),
    );
  }
}
