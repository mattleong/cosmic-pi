/** Provider-agnostic subscription-usage refresh controller shared by provider extensions. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { mergeRefreshRequest, type RefreshRequest } from "./coordination/refresh-coordinator.ts";
import { makeSubscriptionRefresh } from "./coordination/subscription-refresh.ts";
import type { ScopedConfigMetadata } from "./config/scoped-config-store.ts";
import { AgentDirectory } from "./platform/agent-directory.ts";
import {
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "./platform/json-document.ts";
import { JsonHttpClient } from "./platform/json-http.ts";
import { makeFrozenProjection } from "./projection.ts";
import { maskIdentifier } from "./security.ts";
import { formatTimestampOrNever } from "./subscription-format.ts";
import type { UsageProjectionBase } from "./usage-projection.ts";

/** Usage configuration fields the shared controller relies on. */
export interface UsageControllerConfigFields {
  readonly enabled: boolean;
  readonly refreshIntervalMs: number;
  readonly showOnlyOnSubscriptionModels: boolean;
}

/** Minimal resolved-config shape required by the shared controller. */
export type UsageControllerConfig = ScopedConfigMetadata & {
  readonly usage: UsageControllerConfigFields;
};

/** Core services every provider usage stack depends on. */
export type UsageProviderRequirements = Path.Path | JsonDocumentStore | JsonHttpClient;

/** Provider fetch result. `patch` carries provider identity fields into the projection. */
export type UsageFetchOutcome<Snapshot, Patch> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failure"; readonly message: string; readonly patch?: Patch }
  | { readonly _tag: "Success"; readonly snapshot: Snapshot; readonly patch: Patch };

/** Best-effort UI probe: skip only when the host explicitly reports no UI at all. */
const hostHasUi = (ctx: ExtensionContext): boolean => {
  try {
    return ctx.hasUI !== false;
  } catch {
    return true;
  }
};

type RefreshValue<Snapshot, Patch> =
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Disabled"; readonly notify: boolean }
  | { readonly _tag: "Hidden"; readonly notify: boolean }
  | { readonly _tag: "Missing"; readonly notify: boolean; readonly fetchedAt: number }
  | {
      readonly _tag: "Failure";
      readonly notify: boolean;
      readonly fetchedAt: number;
      readonly message: string;
      readonly patch?: Patch;
    }
  | {
      readonly _tag: "Success";
      readonly notify: boolean;
      readonly fetchedAt: number;
      readonly snapshot: Snapshot;
      readonly patch: Patch;
    };

/** Scoped configuration store operations used by the shared controller. */
export interface UsageControllerStore<Resolved, E> {
  readonly resolveConfig: (
    cwd: string,
    agentDir: string,
    projectTrusted?: boolean,
  ) => Effect.Effect<Resolved, E, JsonDocumentStore | Path.Path>;
  readonly readRawConfig: (path: string) => Effect.Effect<JsonObject, E, JsonDocumentStore>;
  readonly resolveCommittedConfig: (
    current: Resolved,
    committed: JsonObject,
    globalFallback: JsonObject | undefined,
  ) => Resolved;
  readonly modifyConfig: <A, AfterCommitR = never>(
    path: string,
    modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
  ) => Effect.Effect<A, E, JsonDocumentStore | AfterCommitR>;
}

export interface UsageRefreshControllerOptions<
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
  E,
  EI,
  R,
> {
  /** Span prefix, e.g. "pi-better-xai.usage" (refresh span becomes `${spanPrefix}.refresh`). */
  readonly spanPrefix: string;
  /** Human-readable label used in recovery log messages, e.g. "Better xAI". */
  readonly logLabel: string;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projection: MutableRef.MutableRef<P>;
  readonly onChange: () => void;
  readonly startPolling?: boolean | undefined;
  readonly agentDir?: string | undefined;
  readonly projectTrusted?: boolean | undefined;
  /** Provider initial projection (shared fields plus provider identity fields). */
  readonly initialProjection: () => P;
  /** Status text published when the current model is not an eligible subscription model. */
  readonly hiddenStatusText: string;
  readonly missingCredentialsMessage: (authPath: string) => string;
  /** Identity fields cleared when credentials go missing (e.g. authFound/teamId). */
  readonly clearAuthPatch: Partial<P>;
  readonly store: UsageControllerStore<Resolved, E>;
  readonly decodeSettingUpdate: (
    id: string,
    value: string,
  ) => Effect.Effect<(document: JsonObject) => JsonObject, EI>;
  /** Whether usage applies to the current model under the resolved configuration. */
  readonly eligibility: (
    ctx: ExtensionContext,
    cfg: Resolved,
  ) => Effect.Effect<boolean, never, UsageProviderRequirements | R>;
  /** Applies context eligibility (and provider clearing rules) to the projection. */
  readonly synchronizeState: (
    current: P,
    ctx: ExtensionContext,
    clearUsage: boolean,
  ) => Effect.Effect<P, never, UsageProviderRequirements | R>;
  /** Optional extra refresh-key segment (e.g. a per-model usage scope). */
  readonly refreshKeyScope?: ((ctx: ExtensionContext) => string) | undefined;
  /** Fetches credentials and usage; infrastructure failures must be mapped to outcomes. */
  readonly fetchOutcome: (args: {
    readonly ctx: ExtensionContext;
    readonly cfg: Resolved;
    readonly authPath: string;
  }) => Effect.Effect<
    UsageFetchOutcome<Snapshot, Partial<P>>,
    never,
    UsageProviderRequirements | R
  >;
  readonly formatStatusLine: (snapshot: Snapshot, cfg: Resolved, fetchedAt: number) => string;
  readonly formatStatusText: (snapshot: Snapshot, fetchedAt: number) => string;
  /** Pins the package's service instances onto effects that escape the layer scope. */
  readonly provideDependencies: <A, E2>(
    effect: Effect.Effect<A, E2, UsageProviderRequirements | R>,
  ) => Effect.Effect<A, E2>;
}

export interface UsageRefreshController<
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
  E,
  EI,
  R,
> {
  readonly refresh: (request?: RefreshRequest) => Effect.Effect<void>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly updateSetting: (id: string, value: string) => Effect.Effect<void, E | EI>;
  readonly agentDir: string;
  readonly authPath: string;
  /** Extension seams for provider-specific config mutations sharing the same serialization. */
  readonly getState: Effect.Effect<P>;
  readonly updateState: (f: (current: P) => P) => Effect.Effect<P>;
  readonly synchronize: (
    clearUsage?: boolean,
  ) => Effect.Effect<void, never, UsageProviderRequirements | R>;
  readonly withSettingsPermit: <A, E2, R2>(
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
  readonly readGlobalFallback: (
    current: Resolved,
  ) => Effect.Effect<JsonObject | undefined, E, JsonDocumentStore>;
  readonly invalidate: Effect.Effect<void>;
  readonly provideDependencies: <A, E2>(
    effect: Effect.Effect<A, E2, UsageProviderRequirements | R>,
  ) => Effect.Effect<A, E2>;
}

/**
 * Builds the standard provider usage controller: interval/coalesced refresh with stale-commit
 * suppression, Disabled/Hidden/Missing/Failure/Success projection commits, and the
 * semaphore-serialized setting-update flow against the package's scoped config store.
 */
export const makeUsageRefreshController = <
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
  E,
  EI,
  R = never,
>(
  options: UsageRefreshControllerOptions<P, Resolved, Snapshot, E, EI, R>,
) =>
  Effect.gen(function* () {
    const { context, cwd, projection, onChange, logLabel, provideDependencies } = options;
    const path = yield* Path.Path;
    const agentDir = options.agentDir ?? (yield* AgentDirectory);
    const authPath = path.join(agentDir, "auth.json");
    const projectTrusted = options.projectTrusted === true;
    const config = yield* options.store.resolveConfig(cwd, agentDir, projectTrusted);
    // The overridden fields all belong to UsageProjectionBase, so the merge stays within P.
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    const mergeState = (
      current: P,
      base: Partial<UsageProjectionBase<Resolved, Snapshot>>,
      patch?: Partial<P>,
    ): P => ({ ...current, ...base, ...patch }) as P;
    const state = yield* makeFrozenProjection<P, P>(
      mergeState(options.initialProjection(), { config, authPath }),
      (current) => current,
      (published) => MutableRef.set(projection, published),
    );
    const settingUpdates = yield* Semaphore.make(1);
    const updateState = (f: (current: P) => P) =>
      state
        .transition((current) => {
          const next = f(current);
          return Effect.succeed([next, next] as const);
        })
        .pipe(Effect.orDie);
    // Best-effort host UI adapter: a failing host callback is logged, never propagated.
    const notifyHost = <Result>(operation: string, action: () => Result) =>
      Effect.suspend(() => {
        try {
          action();
          return Effect.void;
        } catch {
          return Effect.logWarning(`${logLabel} UI recovery: ${operation}_failed.`);
        }
      }).pipe(Effect.asVoid);
    const notifyChanged = notifyHost("render", onChange);
    const notifyUser = (message: string, level: "info" | "warning") =>
      notifyHost("notify", () => MutableRef.get(context).ui.notify(message, level));
    const synchronize = (clearUsage = false) =>
      state
        .transition((current) =>
          options
            .synchronizeState(current, MutableRef.get(context), clearUsage)
            .pipe(Effect.map((next) => [undefined, next] as const)),
        )
        .pipe(Effect.orDie, Effect.asVoid);
    yield* synchronize(true);

    const key = Effect.gen(function* () {
      const ctx = MutableRef.get(context);
      const current = yield* state.getState;
      const segments = [
        `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}`,
        ...(options.refreshKeyScope ? [options.refreshKeyScope(ctx)] : []),
        String(current.config?.usage.enabled ?? false),
        String(current.config?.usage.showOnlyOnSubscriptionModels ?? true),
      ];
      return segments.join(":");
    });
    const refreshEngine = yield* makeSubscriptionRefresh<
      RefreshRequest,
      string,
      RefreshValue<Snapshot, Partial<P>>,
      never,
      UsageProviderRequirements | R
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
          if (!cfg || !hostHasUi(ctx)) return { _tag: "Skipped" } as const;
          const now = yield* Clock.currentTimeMillis;
          if (!cfg.usage.enabled) return { _tag: "Disabled", notify } as const;
          if (!(yield* options.eligibility(ctx, cfg))) return { _tag: "Hidden", notify } as const;
          if (
            !request.force &&
            !request.notify &&
            current.lastFetchAt !== undefined &&
            now - current.lastFetchAt < cfg.usage.refreshIntervalMs
          )
            return { _tag: "Skipped" } as const;
          const outcome = yield* options.fetchOutcome({ ctx, cfg, authPath });
          if (outcome._tag === "Missing")
            return { _tag: "Missing", notify, fetchedAt: now } as const;
          if (outcome._tag === "Failure") {
            const failure: RefreshValue<Snapshot, Partial<P>> = {
              _tag: "Failure",
              notify,
              fetchedAt: now,
              message: outcome.message,
            };
            return outcome.patch ? { ...failure, patch: outcome.patch } : failure;
          }
          return {
            _tag: "Success",
            notify,
            fetchedAt: now,
            snapshot: outcome.snapshot,
            patch: outcome.patch,
          } as const;
        }),
      commit: (value) =>
        Effect.gen(function* () {
          if (value._tag === "Skipped") return;
          if (value._tag === "Failure")
            yield* Effect.logWarning(`${logLabel} usage recovery: refresh_failed.`);
          if (value._tag === "Missing")
            yield* Effect.logWarning(`${logLabel} usage recovery: credentials_missing.`);
          const latest = yield* updateState((current) => {
            const cfg = current.config!;
            if (value._tag === "Disabled" || value._tag === "Hidden")
              return mergeState(current, {
                eligible: false,
                snapshot: undefined,
                statusLine: undefined,
                error: undefined,
                statusText:
                  value._tag === "Disabled"
                    ? "Usage display is disabled."
                    : options.hiddenStatusText,
              });
            if (value._tag === "Failure" || value._tag === "Missing") {
              const missing = value._tag === "Missing";
              const message = missing ? options.missingCredentialsMessage(authPath) : value.message;
              return mergeState(
                current,
                {
                  eligible: true,
                  snapshot: undefined,
                  statusLine: undefined,
                  error: message,
                  statusText: `Usage unavailable: ${message}`,
                  lastFetchAt: value.fetchedAt,
                },
                missing ? options.clearAuthPatch : value.patch,
              );
            }
            return mergeState(
              current,
              {
                eligible: true,
                snapshot: value.snapshot,
                statusLine: options.formatStatusLine(value.snapshot, cfg, value.fetchedAt),
                statusText: options.formatStatusText(value.snapshot, value.fetchedAt),
                error: undefined,
                updatedAt: value.fetchedAt,
                lastFetchAt: value.fetchedAt,
              },
              value.patch,
            );
          });
          yield* notifyChanged;
          if ("notify" in value && value.notify)
            yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
        }),
      spanName: `${options.spanPrefix}.refresh`,
    });
    const refresh = (request: RefreshRequest = {}) =>
      provideDependencies(refreshEngine.request(request));
    const contextChanged = (clearUsage = false) =>
      provideDependencies(
        synchronize(clearUsage).pipe(Effect.andThen(refreshEngine.invalidate), Effect.asVoid),
      );
    const readGlobalFallback = Effect.fn(`${options.spanPrefix}.readGlobalFallback`)(function* (
      current: Resolved,
    ) {
      if (current.configPath !== current.projectConfigPath || !current.globalConfigExists)
        return undefined;
      return yield* options.store.readRawConfig(current.globalConfigPath);
    });
    const updateSettingWithRequirements = Effect.fn(`${options.spanPrefix}.updateSetting`)(
      function* (id: string, value: string) {
        const update = yield* options.decodeSettingUpdate(id, value);
        yield* settingUpdates.withPermit(
          Effect.gen(function* () {
            const freshConfig = yield* options.store.resolveConfig(cwd, agentDir, projectTrusted);
            const globalFallback = yield* readGlobalFallback(freshConfig);
            yield* options.store.modifyConfig(freshConfig.configPath, (raw) => {
              const committed = update(raw);
              const nextConfig = options.store.resolveCommittedConfig(
                freshConfig,
                committed,
                globalFallback,
              );
              return {
                value: nextConfig,
                document: committed,
                afterCommit: updateState((latest) =>
                  mergeState(latest, { config: nextConfig }),
                ).pipe(Effect.andThen(synchronize(true))),
              };
            });
          }),
        );
        yield* refreshEngine.invalidate;
        yield* refresh({ force: true });
      },
    );
    const updateSetting = (id: string, value: string) =>
      provideDependencies(updateSettingWithRequirements(id, value));
    if (options.startPolling !== false) {
      yield* Effect.gen(function* () {
        yield* refresh({ force: true });
        yield* provideDependencies(refreshEngine.startPolling({}));
      }).pipe(Effect.forkScoped);
    }
    const controller: UsageRefreshController<P, Resolved, Snapshot, E, EI, R> = {
      refresh,
      contextChanged,
      updateSetting,
      agentDir,
      authPath,
      getState: state.getState,
      updateState,
      synchronize,
      withSettingsPermit: (effect) => settingUpdates.withPermit(effect),
      readGlobalFallback,
      invalidate: refreshEngine.invalidate,
      provideDependencies,
    };
    return controller;
  });

/** Input for the shared usage debug report. */
export interface UsageDebugReport {
  readonly usageEnabled: boolean;
  readonly currentModel: string;
  readonly eligible: boolean;
  readonly requiresSubscriptionModel: boolean;
  /** Rendered auth summary, e.g. "found", "found (authFile)", or "missing". */
  readonly auth: string;
  /** Provider identity line; the value is masked before rendering. */
  readonly identityLabel: string;
  readonly identityValue: string | undefined;
  readonly lastFetchAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly error: string | undefined;
  readonly refreshIntervalMs: number;
  readonly endpoint: string;
  readonly authPath: string | undefined;
}

/** Renders the standard provider usage debug report from projection-owned data. */
export function formatUsageDebugReport(report: UsageDebugReport): string {
  return [
    `Usage enabled: ${report.usageEnabled}`,
    `Current model: ${report.currentModel}`,
    `Current model eligible: ${report.eligible}`,
    `Requires subscription model: ${report.requiresSubscriptionModel}`,
    `Auth: ${report.auth}`,
    `${report.identityLabel}: ${maskIdentifier(report.identityValue) ?? "none"}`,
    `Last fetch: ${formatTimestampOrNever(report.lastFetchAt)}`,
    `Last successful update: ${formatTimestampOrNever(report.updatedAt)}`,
    `Last error: ${report.error ?? "none"}`,
    `Refresh interval: ${report.refreshIntervalMs}ms`,
    `Endpoint: ${report.endpoint}`,
    `Auth file: ${report.authPath ?? "unknown"}`,
  ].join("\n");
}
