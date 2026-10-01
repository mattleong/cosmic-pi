import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Result from "effect/Result";
import {
  InvalidSettingError,
  makeUsageRefreshController,
  timedDiagnosticResult,
  type UsageFetchOutcome,
} from "pi-cosmic-core";
import { ModelRegistryAuth } from "../boundary/model-registry-auth.ts";
import { decodeSettingUpdate } from "../config/options.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import {
  modifyConfig,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  type XaiConfigError,
} from "../config/store.ts";
import { requestXaiUsage } from "./request.ts";
import { formatUsageDetails, formatUsageSnapshot, type UsageSnapshot } from "./format.ts";
import {
  HIDDEN_USAGE_STATUS_TEXT,
  initialXaiProjection,
  isXaiSubscriptionModel,
  type XaiProjection,
} from "./projection.ts";

export interface XaiUsageServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projection: MutableRef.MutableRef<XaiProjection>;
  readonly onChange: () => void;
  readonly canPublish?: () => boolean;
  readonly startPolling?: boolean;
  readonly isUsageVisible?: () => boolean;
  readonly agentDir?: string;
  readonly projectTrusted?: boolean;
  /** Owned domain seam for deterministic refresh/concurrency tests. */
  readonly requestUsage?: typeof requestXaiUsage;
}

export class XaiUsageService extends Context.Service<XaiUsageService>()(
  "pi-better-xai/usage/controller/XaiUsageService",
  {
    make: Effect.fnUntraced(function* (options: XaiUsageServiceOptions) {
      const registryAuth = yield* ModelRegistryAuth;
      const requestUsage = options.requestUsage ?? requestXaiUsage;
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
        canPublish: options.canPublish,
        startPolling: options.startPolling,
        backgroundEnabled: options.isUsageVisible,
        agentDir: options.agentDir,
        projectTrusted: options.projectTrusted,
        initialProjection: initialXaiProjection,
        hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
        missingCredentialsMessage: () => "Sign in with /login xai",
        clearAuthPatch: { authFound: false, teamId: undefined },
        store: { resolveConfig, readRawConfig, resolveCommittedConfig, modifyConfig },
        decodeSettingUpdate,
        eligibility: (ctx, cfg) => Effect.sync(() => isXaiSubscriptionModel(ctx, cfg)),
        fetchOutcome: () =>
          timedDiagnosticResult(requestUsage(), "xAI usage request timed out.").pipe(
            Effect.map(
              (result): UsageFetchOutcome<UsageSnapshot, Partial<XaiProjection>> =>
                Result.isFailure(result)
                  ? { _tag: "Failure", message: result.failure }
                  : !result.success
                    ? { _tag: "Missing" }
                    : {
                        _tag: "Success",
                        snapshot: result.success.snapshot,
                        patch: { authFound: true, teamId: result.success.teamId },
                      },
            ),
          ),
        formatStatusLine: (snapshot, cfg, fetchedAt) =>
          formatUsageSnapshot(snapshot, cfg.usage, fetchedAt),
        formatStatusText: formatUsageDetails,
        dependencies: Context.make(ModelRegistryAuth, registryAuth),
      });
      return {
        refresh: controller.refresh,
        contextChanged: controller.contextChanged,
        updateSetting: controller.updateSetting,
      };
    }, Effect.withSpan("pi-better-xai.usage.initialize")),
  },
) {
  static layer(options: XaiUsageServiceOptions) {
    return Layer.effect(this, this.make(options)).pipe(
      Layer.provide(ModelRegistryAuth.layer(() => MutableRef.get(options.context).modelRegistry)),
    );
  }
}
