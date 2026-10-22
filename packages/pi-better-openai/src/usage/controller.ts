import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as MutableRef from "effect/MutableRef";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  makeUsageRefreshController,
  timedDiagnosticResult,
  UsageFetchOutcome,
} from "pi-cosmic-core";
import { getCodexCredentials } from "../auth/codex-auth.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { OpenAIConfigService } from "../config/store.ts";
import {
  formatUsageDetails,
  formatUsageSnapshot,
  requestCodexUsageWithCredentials,
  type UsageSnapshot,
} from "./format.ts";
import {
  HIDDEN_USAGE_STATUS_TEXT,
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
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly onChange: () => void;
  readonly canPublish?: () => boolean;
  readonly startPolling?: boolean;
  readonly isUsageVisible?: () => boolean;
}

export class OpenAIUsageService extends Context.Service<OpenAIUsageService>()(
  "pi-better-openai/usage/controller/OpenAIUsageService",
  {
    make: Effect.fnUntraced(function* (options: OpenAIUsageServiceOptions) {
      const config = yield* OpenAIConfigService;
      const controller = yield* makeUsageRefreshController<
        OpenAIProjection,
        ResolvedConfig,
        UsageSnapshot
      >({
        spanPrefix: "pi-better-openai.usage",
        logLabel: "Better OpenAI",
        context: options.context,
        initialConfig: yield* config.get,
        projection: options.projection,
        onChange: options.onChange,
        canPublish: options.canPublish,
        backgroundEnabled: options.isUsageVisible,
        initialProjection,
        hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT,
        missingCredentialsMessage: "Sign in with /login openai-codex",
        clearAuthPatch: { authFound: false, accountId: undefined },
        eligibility: (ctx, cfg) => Effect.succeed(isOpenAISubscriptionModel(ctx, cfg)),
        synchronizeState: (current, ctx, clearUsage) =>
          Effect.succeed(synchronizedProjection(current, ctx, clearUsage)),
        fetchOutcome: ({ ctx }) =>
          Effect.gen(function* () {
            const authAttempt = yield* timedDiagnosticResult(
              getCodexCredentials(ctx),
              "Codex credential lookup timed out.",
            );
            if (Result.isFailure(authAttempt))
              return UsageFetchOutcome.Failure({ message: authAttempt.failure });
            const credentials = authAttempt.success;
            if (credentials === undefined) return UsageFetchOutcome.Missing();
            const authPatch = { authFound: true, accountId: credentials.accountId } as const;
            const usage = yield* timedDiagnosticResult(
              requestCodexUsageWithCredentials(credentials),
              "Codex usage request timed out.",
            );
            if (Result.isFailure(usage))
              return UsageFetchOutcome.Failure({ message: usage.failure, patch: authPatch });
            return UsageFetchOutcome.Success({ snapshot: usage.success, patch: authPatch });
          }),
        formatStatusLine: (snapshot, cfg, fetchedAt) =>
          formatUsageSnapshot(snapshot, cfg.usage, fetchedAt),
        formatStatusText: formatUsageDetails,
        dependencies: Context.empty(),
      });
      yield* config.observe({
        commit: ({ previous, config: next, reason }) =>
          controller.configure(next, {
            invalidate: reason !== "fast" || usageConfigChanged(previous, next),
          }),
        settled: ({ reason }) =>
          reason === "setting" ? controller.refresh({ force: true }) : Effect.void,
      });
      if (options.startPolling !== false) yield* controller.startPolling();
      return {
        refresh: controller.refresh,
        contextChanged: controller.contextChanged,
      };
    }, Effect.withSpan("pi-better-openai.usage.initialize")),
  },
) {
  static layer(options: OpenAIUsageServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
