import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  JsonHttpClient,
  makeRefreshCoordinator,
  type RefreshRequest,
} from "pi-cosmic-core";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { readXaiAuth } from "./auth.ts";
import {
  applySettingToRawConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
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
  readonly projection: MutableRef.MutableRef<XaiProjection>;
  readonly refresh: (options?: RefreshOptions) => Effect.Effect<void>;
  readonly updateSetting: (id: string, value: string) => Effect.Effect<void, XaiConfigError>;
}

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
        const agentDir = options.agentDir ?? (yield* Effect.sync(() => getAgentDir()));
        const authPath = path.join(agentDir, "auth.json");
        const coordinator = yield* makeRefreshCoordinator();
        const dependencies = yield* Effect.context<
          Path.Path | JsonDocumentStore | JsonHttpClient
        >();
        const config = yield* resolveConfig(cwd, agentDir);
        MutableRef.set(projection, {
          ...MutableRef.get(projection),
          config,
          statusText: "Usage unavailable.",
          authPath,
        });
        synchronizeProjectionContext(projection, MutableRef.get(context));

        const notifyChanged = Effect.fn("XaiUsageService.notifyChanged")(function* () {
          yield* Effect.try({
            try: onChange,
            catch: () =>
              new XaiBoundaryError({
                operation: "render",
                message: "Unable to update Better xAI UI.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        });

        const notifyUser = Effect.fn("XaiUsageService.notifyUser")(function* (
          message: string,
          level: "info" | "warning",
        ) {
          const ctx = MutableRef.get(context);
          yield* Effect.try({
            try: () => ctx.ui.notify(message, level),
            catch: () =>
              new XaiBoundaryError({
                operation: "notify",
                message: "Unable to notify Better xAI status.",
              }),
          }).pipe(Effect.catch(() => Effect.void));
        });

        const refreshOnce = Effect.fn("XaiUsageService.refreshOnce")(function* (
          refreshOptions: RefreshOptions,
        ) {
          const ctx = MutableRef.get(context);
          const current = MutableRef.get(projection);
          const cfg = current.config;
          if (!cfg) return;
          const now = yield* Clock.currentTimeMillis;
          if (!cfg.usage.enabled) {
            MutableRef.set(projection, {
              ...current,
              eligible: false,
              snapshot: undefined,
              statusLine: undefined,
              error: undefined,
              statusText: "Usage display is disabled.",
            });
            yield* notifyChanged();
            if (refreshOptions.notify) yield* notifyUser("Usage display is disabled.", "warning");
            return;
          }
          if (!isXaiSubscriptionModel(ctx, cfg)) {
            const statusText = "Usage hidden: current model is not an xAI subscription model.";
            MutableRef.set(projection, {
              ...current,
              eligible: false,
              snapshot: undefined,
              statusLine: undefined,
              error: undefined,
              statusText,
            });
            yield* notifyChanged();
            if (refreshOptions.notify) yield* notifyUser(statusText, "warning");
            return;
          }
          if (
            !refreshOptions.force &&
            !refreshOptions.notify &&
            current.lastFetchAt !== undefined &&
            now - current.lastFetchAt < cfg.usage.refreshIntervalMs
          ) {
            return;
          }

          MutableRef.set(projection, {
            ...current,
            eligible: true,
            error: undefined,
            lastFetchAt: now,
          });
          const snapshot = yield* requestXaiUsage(authPath, ctx).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch((error) => {
              const message = sanitizeDiagnosticError(
                typeof error.message === "string" ? error.message : "xAI usage request timed out.",
              );
              const failed = MutableRef.get(projection);
              MutableRef.set(projection, {
                ...failed,
                statusLine: undefined,
                error: message,
                statusText: `Usage unavailable: ${message}`,
              });
              return Effect.void;
            }),
          );
          const auth = yield* readXaiAuth(authPath);
          const refreshedAt = yield* Clock.currentTimeMillis;
          const next = MutableRef.get(projection);
          if (snapshot) {
            const statusLine = formatUsageSnapshot(snapshot, cfg.usage, refreshedAt);
            MutableRef.set(projection, {
              ...next,
              eligible: true,
              snapshot,
              statusLine,
              statusText: formatUsageDetails(snapshot, refreshedAt),
              error: undefined,
              updatedAt: refreshedAt,
              authFound: auth !== undefined,
              teamId: auth?.teamId,
            });
          } else if (!MutableRef.get(projection).error) {
            const missing = `Missing xAI OAuth credentials in ${authPath}. Run /login xai.`;
            MutableRef.set(projection, {
              ...next,
              eligible: true,
              snapshot: undefined,
              statusLine: undefined,
              error: missing,
              statusText: `Usage unavailable: ${missing}`,
              authFound: auth !== undefined,
              teamId: auth?.teamId,
            });
          }
          yield* notifyChanged();
          if (refreshOptions.notify) {
            const latest = MutableRef.get(projection);
            yield* notifyUser(latest.statusText, latest.snapshot ? "info" : "warning");
          }
        });

        const refresh = (refreshOptions: RefreshOptions = {}) =>
          coordinator.run(refreshOptions, refreshOnce).pipe(Effect.provideContext(dependencies));

        const updateSettingWithRequirements = Effect.fn("XaiUsageService.updateSetting")(function* (
          id: string,
          value: string,
        ) {
          const current = MutableRef.get(projection);
          if (!current.config) return;
          const raw = yield* readRawConfig(current.config.configPath);
          const nextRaw = applySettingToRawConfig(raw, id, value);
          yield* writeConfig(current.config.configPath, nextRaw);
          const nextConfig = yield* resolveConfig(cwd, agentDir);
          MutableRef.set(projection, { ...MutableRef.get(projection), config: nextConfig });
          synchronizeProjectionContext(projection, MutableRef.get(context), { clearUsage: true });
          yield* refresh({ force: true });
        });
        const updateSetting = (id: string, value: string) =>
          updateSettingWithRequirements(id, value).pipe(Effect.provideContext(dependencies));

        if (options.startPolling !== false) {
          yield* Effect.gen(function* () {
            yield* refresh({ force: true });
            while (true) {
              const interval = MutableRef.get(projection).config?.usage.refreshIntervalMs ?? 60_000;
              yield* Effect.sleep(interval);
              yield* refresh();
            }
          }).pipe(Effect.forkScoped);
        }

        return XaiUsageService.of({ projection, refresh, updateSetting });
      }),
    );
  }
}

export function statusLine(projection: MutableRef.MutableRef<XaiProjection>): string | undefined {
  return MutableRef.get(projection).statusLine;
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
