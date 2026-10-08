/** Provider-agnostic subscription-usage refresh controller shared by provider extensions. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import type * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import type { RefreshRequest } from "./coordination/refresh-coordinator.ts";
import { makeSubscriptionRefresh } from "./coordination/subscription-refresh.ts";
import {
  commitPreferredScope,
  type PreferredScopeStore,
  type ScopedConfigMetadata,
  type ScopedConfigStore,
} from "./config/scoped-config-store.ts";
import { AgentDirectory } from "./platform/agent-directory.ts";
import { JsonDocumentStore, type JsonObject } from "./platform/json-document.ts";
import { JsonHttpClient } from "./platform/json-http.ts";
import { invokeHostCallback } from "./host-session.ts";
import { makeFrozenProjection } from "./projection.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./security.ts";
import { formatTimestampOrNever } from "./subscription-format.ts";
import { withUsageEligibility, type UsageProjectionBase } from "./usage-projection.ts";
import { formatDuration } from "./display.ts";
import { failureMessage, notificationText } from "./message-text.ts";

/** Usage configuration fields the shared controller relies on. */
interface UsageControllerConfigFields {
  readonly refreshIntervalMs: number;
  readonly showOnlyOnSubscriptionModels: boolean;
}

/** Resolved subscription-usage settings. Each provider owns its schema, defaults, and clamping. */
export interface SubscriptionUsageConfig extends UsageControllerConfigFields {
  readonly showResetTimes: boolean;
}

/** Minimal resolved-config shape required by the shared controller. */
export type UsageControllerConfig = ScopedConfigMetadata & {
  readonly usage: UsageControllerConfigFields;
};

/** Core services every provider usage stack depends on. */
type UsageProviderRequirements = Path.Path | JsonDocumentStore | JsonHttpClient;

/** Provider fetch result. `patch` carries provider identity fields into the projection. */
export type UsageFetchOutcome<Snapshot, Patch> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failure"; readonly message: string; readonly patch?: Patch }
  | { readonly _tag: "Success"; readonly snapshot: Snapshot; readonly patch: Patch };

/** Best-effort UI probe: skip only when the host explicitly reports no UI at all. */
const hostHasUi = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.hasUI !== false, true);

type RefreshValue<Snapshot, Patch> =
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Disabled"; readonly notify: boolean }
  | { readonly _tag: "Hidden"; readonly notify: boolean }
  | (UsageFetchOutcome<Snapshot, Patch> & {
      readonly notify: boolean;
      readonly fetchedAt: number;
    });

/** Scoped configuration store operations used by the shared controller. */
type UsageControllerStore<Resolved extends ScopedConfigMetadata, E> = PreferredScopeStore<
  Resolved,
  E
> &
  Pick<ScopedConfigStore<unknown, Resolved, E>, "resolveConfig">;

export interface UsageRefreshControllerOptions<
  P extends UsageProjectionBase<Resolved, Snapshot>,
  Resolved extends UsageControllerConfig,
  Snapshot,
  E,
  EI,
  R,
> {
  /** Span prefix, e.g. "pi-better-openai.usage" (refresh span becomes `${spanPrefix}.refresh`). */
  readonly spanPrefix: string;
  /** Human-readable label used in recovery log messages, e.g. "Better OpenAI". */
  readonly logLabel: string;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projection: MutableRef.MutableRef<P>;
  readonly onChange: () => void;
  /** Revoked synchronously by the originating session before reset and disposal. */
  readonly canPublish?: (() => boolean) | undefined;
  readonly startPolling?: boolean | undefined;
  /** Presentation owner controls automatic requests; explicit notified requests still fetch. */
  readonly backgroundEnabled?: (() => boolean) | undefined;
  readonly projectTrusted?: boolean | undefined;
  /** Provider initial projection (shared fields plus provider identity fields). */
  readonly initialProjection: () => P;
  /** Status text published when the current model is not an eligible subscription model. */
  readonly hiddenStatusText: string;
  readonly missingCredentialsMessage: string;
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
  readonly synchronizeState?: (
    current: P,
    ctx: ExtensionContext,
    clearUsage: boolean,
  ) => Effect.Effect<P, never, UsageProviderRequirements | R>;
  /** Optional extra refresh-key segment (e.g. a per-model usage scope). */
  readonly refreshKeyScope?: ((ctx: ExtensionContext) => string) | undefined;
  /** Fetches credentials and usage; infrastructure failures must be mapped to outcomes. */
  readonly fetchOutcome: (args: {
    readonly ctx: ExtensionContext;
  }) => Effect.Effect<
    UsageFetchOutcome<Snapshot, Partial<P>>,
    never,
    UsageProviderRequirements | R
  >;
  readonly formatStatusLine: (snapshot: Snapshot, cfg: Resolved, fetchedAt: number) => string;
  readonly formatStatusText: (snapshot: Snapshot, fetchedAt: number) => string;
  /** Provider-specific services pinned onto effects that escape the layer scope. */
  readonly dependencies: Context.Context<R>;
}

interface UsageRefreshController<
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
  /** Extension seams for provider-specific config mutations sharing the same serialization. */
  readonly getState: Effect.Effect<P>;
  readonly updateState: (f: (current: P) => P) => Effect.Effect<P>;
  /** Installs a committed config, clearing usage and waking polling. */
  readonly installConfig: (config: Resolved) => Effect.Effect<void>;
  readonly withSettingsPermit: <A, E2, R2>(
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
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
    const { context, cwd, projection, onChange, logLabel, store } = options;
    const ambientDependencies = yield* Effect.context<UsageProviderRequirements>();
    // Capture only these shared services, never the whole ambient context. Context.merge keeps
    // the second context on key collisions, so provider dependencies cannot replace them.
    const sharedDependencies = ambientDependencies.pipe(
      Context.pick(Path.Path, JsonDocumentStore, JsonHttpClient, Tracer.Tracer),
    );
    const dependencies = Context.merge(options.dependencies, sharedDependencies);
    const path = Context.get(sharedDependencies, Path.Path);
    const provideDependencies = <A, E2>(
      effect: Effect.Effect<A, E2, UsageProviderRequirements | R>,
    ): Effect.Effect<A, E2> => Effect.provideContext(effect, dependencies);
    const agentDir = yield* AgentDirectory;
    const authPath = path.join(agentDir, "auth.json");
    const projectTrusted = options.projectTrusted === true;
    const config = yield* store.resolveConfig(cwd, agentDir, projectTrusted);
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
      (published) => {
        if (options.canPublish?.() !== false) MutableRef.set(projection, published);
      },
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
    const notifyHost = (operation: string, action: () => void) =>
      Effect.try(() => {
        if (options.canPublish?.() !== false) action();
      }).pipe(
        Effect.catch(() => Effect.logWarning(`${logLabel} UI recovery: ${operation}_failed.`)),
      );
    const notifyChanged = notifyHost("render", onChange);
    const notifyUser = (message: string, level: "info" | "warning") =>
      notifyHost("notify", () =>
        MutableRef.get(context).ui.notify(notificationText(message), level),
      );
    const synchronizeState =
      options.synchronizeState ??
      ((current: P, ctx: ExtensionContext, clearUsage: boolean) =>
        (current.config ? options.eligibility(ctx, current.config) : Effect.succeed(false)).pipe(
          Effect.map((eligible) =>
            withUsageEligibility(current, eligible, clearUsage, {
              hiddenStatusText: options.hiddenStatusText,
            }),
          ),
        ));
    const synchronize = (clearUsage = false) =>
      state
        .transition((current) =>
          synchronizeState(current, MutableRef.get(context), clearUsage).pipe(
            Effect.map((next) => [undefined, next] as const),
          ),
        )
        .pipe(Effect.orDie, Effect.asVoid);
    yield* synchronize(true);

    const key = Effect.gen(function* () {
      const ctx = MutableRef.get(context);
      const current = yield* state.getState;
      const segments = [
        `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}`,
        ...(options.refreshKeyScope ? [options.refreshKeyScope(ctx)] : []),
        String(options.backgroundEnabled?.() ?? true),
        String(current.config?.usage.showOnlyOnSubscriptionModels ?? true),
      ];
      return segments.join(":");
    });
    const refreshEngine = yield* makeSubscriptionRefresh<
      string,
      RefreshValue<Snapshot, Partial<P>>,
      never,
      UsageProviderRequirements | R
    >({
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
          if (options.canPublish?.() === false || !cfg || !hostHasUi(ctx))
            return { _tag: "Skipped" } as const;
          const now = yield* Clock.currentTimeMillis;
          if (!notify && options.backgroundEnabled?.() === false)
            return { _tag: "Disabled", notify } as const;
          if (!(yield* options.eligibility(ctx, cfg))) return { _tag: "Hidden", notify } as const;
          if (
            !request.force &&
            !request.notify &&
            current.lastFetchAt !== undefined &&
            now - current.lastFetchAt < cfg.usage.refreshIntervalMs
          )
            return { _tag: "Skipped" } as const;
          const outcome = yield* options.fetchOutcome({ ctx });
          return { ...outcome, notify, fetchedAt: now };
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
                    ? "Usage is hidden in Cosmic UI"
                    : options.hiddenStatusText,
              });
            if (value._tag === "Failure" || value._tag === "Missing") {
              const missing = value._tag === "Missing";
              const message = missing ? options.missingCredentialsMessage : value.message;
              return mergeState(
                current,
                {
                  eligible: true,
                  snapshot: undefined,
                  statusLine: undefined,
                  error: message,
                  statusText: `Usage unavailable: ${failureMessage(message, "unknown error")}`,
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
      provideDependencies(refreshEngine.invalidateWith(synchronize(clearUsage)));
    const installConfig = (config: Resolved) =>
      provideDependencies(
        refreshEngine.invalidateWith(
          updateState((latest) => mergeState(latest, { config })).pipe(
            Effect.andThen(synchronize(true)),
          ),
        ),
      );
    const updateSettingWithRequirements = Effect.fn(`${options.spanPrefix}.updateSetting`)(
      function* (id: string, value: string) {
        const update = yield* options.decodeSettingUpdate(id, value);
        yield* settingUpdates.withPermit(
          store
            .resolveConfig(cwd, agentDir, projectTrusted)
            .pipe(
              Effect.flatMap((fresh) => commitPreferredScope(store, fresh, update, installConfig)),
            ),
        );
        yield* refresh({ force: true });
      },
    );
    const updateSetting = (id: string, value: string) =>
      provideDependencies(updateSettingWithRequirements(id, value));
    if (options.startPolling !== false)
      yield* refresh({ force: true }).pipe(
        Effect.andThen(provideDependencies(refreshEngine.startPolling({}))),
        Effect.forkScoped,
      );
    const controller: UsageRefreshController<P, Resolved, Snapshot, E, EI, R> = {
      refresh,
      contextChanged,
      updateSetting,
      agentDir,
      getState: state.getState,
      updateState,
      installConfig,
      withSettingsPermit: settingUpdates.withPermit,
      provideDependencies,
    };
    return controller;
  });

/** Provider-owned fields of the shared usage debug report. */
interface UsageDebugReport {
  readonly currentModel: string;
  readonly requiresSubscriptionModel: boolean;
  /** Provider identity line; the value is masked before rendering. */
  readonly identityLabel: string;
  readonly identityValue: string | undefined;
  readonly refreshIntervalMs: number;
  readonly endpoint: string;
}

/** Renders the standard provider usage debug report from projection-owned data. */
export function formatUsageDebugReport(
  state: UsageProjectionBase<unknown, unknown>,
  report: UsageDebugReport,
): string {
  return [
    `Current model: ${report.currentModel}`,
    `Current model eligible: ${state.eligible}`,
    `Requires subscription model: ${report.requiresSubscriptionModel}`,
    `Auth: ${state.authFound ? "found" : "missing"}`,
    `${report.identityLabel}: ${maskIdentifier(report.identityValue) ?? "none"}`,
    `Last fetch: ${formatTimestampOrNever(state.lastFetchAt)}`,
    `Last successful update: ${formatTimestampOrNever(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${formatDuration(report.refreshIntervalMs)}`,
    `Endpoint: ${report.endpoint}`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}

/**
 * Runs one provider diagnostic effect with a bounded 10-second deadline (the shared provider
 * convention) and maps both failures and timeouts onto a sanitized string, so callers only
 * branch on `Result<A, string>`: `Failure` messages are diagnostics, `Success` carries the
 * provider value. A timeout, or a failure without a message, reports `timeoutMessage`.
 */
export const timedDiagnosticResult = <A, E extends { readonly message?: string | undefined }, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMessage: string,
): Effect.Effect<Result.Result<A, string>, never, R> =>
  effect.pipe(
    Effect.mapError((failure) => failure.message ?? timeoutMessage),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(timeoutMessage) }),
    Effect.mapError((message) => sanitizeDiagnosticError(message)),
    Effect.result,
  );
