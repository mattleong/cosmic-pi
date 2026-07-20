import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  AgentDirectory,
  JsonDocumentStore,
  JsonHttpClient,
  makeSubscriptionRefresh,
  type RefreshRequest,
} from "pi-cosmic-core";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { readXaiAuth } from "./auth.ts";
import {
  applySettingToRawConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
  type InvalidSettingError,
  type ResolvedConfig,
  type XaiConfigError,
} from "./config.ts";
import {
  BILLING_BASE_URL,
  type UsageSnapshot,
  formatResetCountdown,
  formatUsageDetails,
  formatUsageSnapshot,
  requestXaiUsage,
} from "./usage.ts";

export interface XaiProjection {
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
  readonly teamId: string | undefined;
}

const initialProjection = (): XaiProjection => ({
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
  teamId: undefined,
});

export const makeProjection = (): MutableRef.MutableRef<XaiProjection> =>
  MutableRef.make(initialProjection());

export function resetProjection(projection: MutableRef.MutableRef<XaiProjection>): void {
  MutableRef.set(projection, initialProjection());
}

export function isXaiSubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model || model.provider !== "xai") return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    (isUsingOAuth ?? ctx.modelRegistry.isUsingOAuth(model))
  );
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  const state = MutableRef.get(projection);
  const eligible = state.config ? isXaiSubscriptionModel(ctx, state.config) : false;
  const statusText = eligible
    ? "Usage unavailable."
    : "Usage hidden: current model is not an xAI subscription model.";
  MutableRef.set(projection, {
    ...state,
    eligible,
    ...(options.clearUsage
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
  projection: MutableRef.MutableRef<XaiProjection>,
): string | undefined {
  if (!cfg.usage.enabled || !isXaiSubscriptionModel(ctx, cfg)) return undefined;
  return MutableRef.get(projection).statusLine;
}

export class XaiBoundaryError extends Schema.TaggedErrorClass<XaiBoundaryError>()(
  "XaiBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface RefreshOptions extends RefreshRequest {}

export interface XaiUsageServiceShape {
  readonly refresh: (options?: RefreshOptions) => Effect.Effect<void>;
  readonly contextChanged: (clearUsage?: boolean) => Effect.Effect<void>;
  readonly updateSetting: (
    id: string,
    value: string,
  ) => Effect.Effect<void, XaiConfigError | InvalidSettingError>;
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
    }
  | {
      readonly _tag: "Success";
      readonly notify: boolean;
      readonly fetchedAt: number;
      readonly snapshot: UsageSnapshot;
      readonly authFound: boolean;
      readonly teamId?: string;
    };

const freezeProjection = (state: XaiProjection): XaiProjection => Object.freeze({ ...state });

export class XaiUsageService extends Context.Service<XaiUsageService, XaiUsageServiceShape>()(
  "pi-better-xai/usage-controller/XaiUsageService",
) {
  static layer(options: {
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly cwd: string;
    readonly projection: MutableRef.MutableRef<XaiProjection>;
    readonly onChange: () => void;
    readonly startPolling?: boolean;
    readonly agentDir?: string;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const { context, cwd, projection, onChange } = options;
        const path = yield* Path.Path;
        const dependencies = yield* Effect.context<
          Path.Path | JsonDocumentStore | JsonHttpClient
        >();
        const agentDir = options.agentDir ?? (yield* AgentDirectory);
        const authPath = path.join(agentDir, "auth.json");
        const config = yield* resolveConfig(cwd, agentDir);
        const state = yield* SynchronizedRef.make<XaiProjection>({
          ...initialProjection(),
          config,
          authPath,
        });
        const publish = (next: XaiProjection) =>
          Effect.sync(() => MutableRef.set(projection, freezeProjection(next)));
        const updateState = (f: (current: XaiProjection) => XaiProjection) =>
          SynchronizedRef.modifyEffect(state, (current) => {
            const next = f(current);
            return publish(next).pipe(Effect.as([next, next] as const));
          });
        const notifyChanged = Effect.try({
          try: onChange,
          catch: () =>
            new XaiBoundaryError({
              operation: "render",
              message: "Unable to update Better xAI UI.",
            }),
        }).pipe(Effect.catch(() => Effect.void));
        const notifyUser = (message: string, level: "info" | "warning") =>
          Effect.try({
            try: () => MutableRef.get(context).ui.notify(message, level),
            catch: () =>
              new XaiBoundaryError({
                operation: "notify",
                message: "Unable to notify Better xAI status.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        const synchronize = (clearUsage = false) =>
          updateState((current) => {
            const ctx = MutableRef.get(context);
            const eligible = current.config ? isXaiSubscriptionModel(ctx, current.config) : false;
            const statusText = eligible
              ? "Usage unavailable."
              : "Usage hidden: current model is not an xAI subscription model.";
            return {
              ...current,
              eligible,
              ...(clearUsage
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
            };
          }).pipe(Effect.asVoid);
        yield* synchronize(true);

        const key = Effect.gen(function* () {
          const ctx = MutableRef.get(context);
          const current = yield* SynchronizedRef.get(state);
          return `${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}:${current.config?.usage.enabled ?? false}:${current.config?.usage.showOnlyOnSubscriptionModels ?? true}`;
        });
        const refreshEngine = yield* makeSubscriptionRefresh<
          RefreshOptions,
          string,
          RefreshValue,
          never,
          Path.Path | JsonDocumentStore | JsonHttpClient
        >({
          mergeRequest: (current, next) => ({
            force: current?.force === true || next.force === true,
            notify: current?.notify === true || next.notify === true,
          }),
          currentKey: key,
          interval: SynchronizedRef.get(state).pipe(
            Effect.map((current) => current.config?.usage.refreshIntervalMs ?? 60_000),
          ),
          fetch: (request) =>
            Effect.gen(function* () {
              const ctx = MutableRef.get(context);
              const current = yield* SynchronizedRef.get(state);
              const cfg = current.config;
              if (!cfg) return { _tag: "Skipped" } as const;
              const now = yield* Clock.currentTimeMillis;
              if (!cfg.usage.enabled)
                return { _tag: "Disabled", notify: request.notify === true } as const;
              if (!isXaiSubscriptionModel(ctx, cfg))
                return { _tag: "Hidden", notify: request.notify === true } as const;
              if (
                !request.force &&
                !request.notify &&
                current.lastFetchAt !== undefined &&
                now - current.lastFetchAt < cfg.usage.refreshIntervalMs
              )
                return { _tag: "Skipped" } as const;
              yield* updateState((latest) => ({
                ...latest,
                eligible: true,
                error: undefined,
                lastFetchAt: now,
              }));
              const result = yield* requestXaiUsage(authPath, ctx).pipe(
                Effect.timeout("10 seconds"),
                Effect.result,
              );
              if (result._tag === "Failure") {
                const message = sanitizeDiagnosticError(
                  typeof result.failure.message === "string"
                    ? result.failure.message
                    : "xAI usage request timed out.",
                );
                return {
                  _tag: "Failure",
                  notify: request.notify === true,
                  fetchedAt: now,
                  message,
                } as const;
              }
              if (!result.success)
                return {
                  _tag: "Missing",
                  notify: request.notify === true,
                  fetchedAt: now,
                } as const;
              const auth = yield* readXaiAuth(authPath).pipe(Effect.result);
              return {
                _tag: "Success",
                notify: request.notify === true,
                fetchedAt: now,
                snapshot: result.success,
                authFound: auth._tag === "Success" && auth.success !== undefined,
                ...(auth._tag === "Success" && auth.success?.teamId
                  ? { teamId: auth.success.teamId }
                  : {}),
              } as const;
            }),
          commit: (value) =>
            Effect.gen(function* () {
              if (value._tag === "Skipped") return;
              const latest = yield* updateState((current) => {
                const cfg = current.config!;
                if (value._tag === "Disabled")
                  return {
                    ...current,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText: "Usage display is disabled.",
                  };
                if (value._tag === "Hidden")
                  return {
                    ...current,
                    eligible: false,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: undefined,
                    statusText: "Usage hidden: current model is not an xAI subscription model.",
                  };
                if (value._tag === "Failure")
                  return {
                    ...current,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: value.message,
                    statusText: `Usage unavailable: ${value.message}`,
                  };
                if (value._tag === "Missing") {
                  const message = `Missing xAI OAuth credentials in ${authPath}. Run /login xai.`;
                  return {
                    ...current,
                    snapshot: undefined,
                    statusLine: undefined,
                    error: message,
                    statusText: `Usage unavailable: ${message}`,
                    authFound: false,
                    teamId: undefined,
                  };
                }
                return {
                  ...current,
                  eligible: true,
                  snapshot: value.snapshot,
                  statusLine: formatUsageSnapshot(value.snapshot, cfg.usage, value.fetchedAt),
                  statusText: formatUsageDetails(value.snapshot, value.fetchedAt),
                  error: undefined,
                  updatedAt: value.fetchedAt,
                  authFound: value.authFound,
                  teamId: value.teamId,
                };
              });
              yield* notifyChanged;
              if ("notify" in value && value.notify)
                yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
            }),
          spanName: "pi-better-xai.usage.refresh",
        });
        const refresh = (request: RefreshOptions = {}) =>
          refreshEngine.request(request).pipe(Effect.provideContext(dependencies));
        const contextChanged = (clearUsage = false) =>
          synchronize(clearUsage).pipe(Effect.andThen(refreshEngine.invalidate), Effect.asVoid);
        const updateSettingWithRequirements = Effect.fn("XaiUsageService.updateSetting")(function* (
          id: string,
          value: string,
        ) {
          const current = yield* SynchronizedRef.get(state);
          if (!current.config) return;
          const raw = yield* readRawConfig(current.config.configPath);
          const nextRaw = yield* applySettingToRawConfig(raw, id, value);
          yield* writeConfig(current.config.configPath, nextRaw);
          const nextConfig = yield* resolveConfig(cwd, agentDir);
          yield* updateState((latest) => ({ ...latest, config: nextConfig }));
          yield* synchronize(true);
          yield* refreshEngine.invalidate;
          yield* refresh({ force: true });
        });
        const updateSetting = (id: string, value: string) =>
          updateSettingWithRequirements(id, value).pipe(Effect.provideContext(dependencies));
        if (options.startPolling !== false) {
          yield* Effect.gen(function* () {
            yield* refresh({ force: true });
            yield* refreshEngine.startPolling({}).pipe(Effect.provideContext(dependencies));
          }).pipe(Effect.forkScoped);
        }
        return XaiUsageService.of({ refresh, contextChanged, updateSetting });
      }).pipe(Effect.withSpan("pi-better-xai.usage.initialize")),
    );
  }
}

export function formatStatus(
  projection: MutableRef.MutableRef<XaiProjection>,
  now: number,
): string {
  const state = MutableRef.get(projection);
  if (!state.config?.usage.enabled) return "Usage display is disabled.";
  if (!state.eligible) return "Usage hidden: current model is not an xAI subscription model.";
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
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  const formatTime = (value: number | undefined) =>
    value === undefined ? "never" : DateTime.formatLocal(DateTime.makeUnsafe(value));
  return [
    `Usage enabled: ${cfg?.usage.enabled ?? false}`,
    `Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
    `Current model eligible: ${cfg ? isXaiSubscriptionModel(ctx, cfg) : false}`,
    `Requires subscription model: ${cfg?.usage.showOnlyOnSubscriptionModels ?? true}`,
    `Auth: ${state.authFound ? "found" : "missing"}`,
    `Team ID: ${maskIdentifier(state.teamId) ?? "none"}`,
    `Last fetch: ${formatTime(state.lastFetchAt)}`,
    `Last successful update: ${formatTime(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${cfg?.usage.refreshIntervalMs ?? 60_000}ms`,
    `Endpoint: ${BILLING_BASE_URL}/billing*`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}
