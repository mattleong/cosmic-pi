import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot, frozenProjection } from "pi-cosmic-core/projection";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import {
  createSubscriptionRefresh,
  recoverRefreshFailure,
} from "pi-cosmic-core/coordination/subscription-refresh";
import { type RefreshRequest } from "pi-cosmic-core/coordination/refresh-coordinator";
import {
  emptyTotals,
  createSessionUsageReader,
  type FooterTotals,
} from "../boundary/host-usage.ts";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { CosmicUiConfigStore, type FooterPatch } from "../config/store.ts";
import type { FooterRepositoryProjection } from "../footer/builtin-contributions.ts";
import type { FooterGitStatus } from "../footer/git.ts";
import { RepositoryProbe } from "../probe/repository-probe.ts";

const PULL_REQUEST_REFRESH_INTERVAL_MS = 30_000;
/** Polling backs off to this after repeated empty or failed pull request lookups. */
const PULL_REQUEST_MAX_REFRESH_INTERVAL_MS = 120_000;
const USAGE_RECONCILE_INTERVAL = "1 second";
const TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
const sameTotals = (left: FooterTotals, right: FooterTotals) =>
  Arr.every(TOTAL_KEYS, (key) => left[key] === right[key]);
const GIT_STATUS_KEYS = [
  "staged",
  "modified",
  "untracked",
  "conflicts",
  "ahead",
  "behind",
  "linesAdded",
  "linesRemoved",
  "linesChanged",
] as const satisfies ReadonlyArray<keyof FooterGitStatus>;
const sameGitStatus = (left: FooterGitStatus | undefined, right: FooterGitStatus | undefined) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    Arr.every(GIT_STATUS_KEYS, (key) => left[key] === right[key]));
export interface CosmicUiProjection extends FooterRepositoryProjection {
  readonly config: ResolvedCosmicUiConfig | undefined;
  readonly pullRequestCheckedAt: number;
  readonly probeRevision: number;
}
interface CosmicUiLiveState extends CosmicUiProjection {
  readonly config: ResolvedCosmicUiConfig;
}
const initialProjection = (totals = emptyTotals()): CosmicUiProjection => ({
  config: undefined,
  totals,
  gitStatus: undefined,
  pullRequestNumber: undefined,
  pullRequestUrl: undefined,
  pullRequestCheckedAt: 0,
  probeRevision: 0,
  homeDirectory: undefined,
});
export const createProjection = () =>
  MutableRef.make<CosmicUiProjection>(freezeSnapshot(initialProjection()));
export const resetProjection = (
  projection: MutableRef.MutableRef<CosmicUiProjection>,
  totals = emptyTotals(),
): void => void MutableRef.set(projection, freezeSnapshot(initialProjection(totals)));

export interface CosmicUiServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  /** The originating session, whose persisted usage the footer reconciles. */
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly cwd: string;
  readonly initialTotals?: FooterTotals;
  readonly readUsageTotals?: () => FooterTotals | undefined;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly onChange: () => void;
  /** Runs before `onChange` when reconciled usage totals change. */
  readonly onUsageChange?: (() => void) | undefined;
  readonly canPublish?: (() => boolean) | undefined;
  readonly startPolling?: boolean;
  readonly projectTrusted: boolean;
}

export class CosmicUiService extends Context.Service<CosmicUiService>()(
  "pi-cosmic-ui/protocol/service/CosmicUiService",
  {
    make: Effect.fn("CosmicUiService.make")(function* (options: CosmicUiServiceOptions) {
      const configStore = yield* CosmicUiConfigStore;
      const probes = yield* RepositoryProbe;
      const settingsLock = yield* Semaphore.make(1);
      const usageLock = yield* Semaphore.make(1);
      const home = yield* Config.option(Config.String("HOME"));
      const config = yield* configStore.resolve(options.cwd, options.projectTrusted);
      const initialTotals = options.initialTotals ?? MutableRef.get(options.projection).totals;
      const state = yield* frozenProjection<CosmicUiLiveState, CosmicUiProjection>(
        {
          ...initialProjection(),
          totals: initialTotals,
          config,
          homeDirectory: Option.getOrUndefined(home),
        },
        (current) => current,
        (published) => {
          if (options.canPublish?.() !== false) MutableRef.set(options.projection, published);
        },
      );
      const updateState = (f: (current: CosmicUiLiveState) => CosmicUiLiveState) =>
        state
          .transition((current) => Effect.succeed([undefined, f(current)] as const))
          .pipe(Effect.orDie);
      const notifyChanged = Effect.sync(() => {
        if (options.canPublish?.() !== false) options.onChange();
      });
      const commit = (f: (current: CosmicUiLiveState) => CosmicUiLiveState) =>
        updateState(f).pipe(Effect.andThen(notifyChanged));
      let lastKnownCwd = options.cwd;
      const currentCwd = () =>
        invokeHostCallback(() => {
          const cwd = MutableRef.get(options.context).sessionManager.getCwd();
          lastKnownCwd = cwd;
          return cwd;
        }, lastKnownCwd);
      const isTui = () =>
        invokeHostCallback<ExtensionContext["mode"]>(
          () => MutableRef.get(options.context).mode,
          "rpc",
        ) === "tui";
      const currentKey = state.getState.pipe(
        Effect.map((current) => `${currentCwd()}\u0000${current.probeRevision}`),
      );
      const fetchGit = Effect.fnUntraced(function* () {
        const revision = (yield* state.getState).probeRevision;
        if (!isTui()) return undefined;
        const cwd = currentCwd();
        return yield* probes
          .git(cwd, () => state.getSnapshot().probeRevision === revision && currentCwd() === cwd)
          .pipe(Effect.orElseSucceed(() => undefined));
      });
      /**
       * Time a poll waits after the last lookup. It doubles after each polled lookup that finds no
       * pull request, including a failed one. Polls wake at the base interval, so a forced lookup,
       * which restores it, takes effect without waiting out the back-off.
       */
      let pullRequestPollDelay = PULL_REQUEST_REFRESH_INTERVAL_MS;
      const fetchPullRequest = Effect.fnUntraced(function* (request: RefreshRequest) {
        if (!isTui()) return undefined;
        const current = yield* state.getState;
        const now = yield* Clock.currentTimeMillis;
        if (!request.force && now - current.pullRequestCheckedAt < pullRequestPollDelay)
          return undefined;
        const pullRequest = yield* probes
          .pullRequest(currentCwd())
          .pipe(Effect.orElseSucceed(() => undefined));
        pullRequestPollDelay =
          pullRequest === undefined && !request.force
            ? Math.min(pullRequestPollDelay * 2, PULL_REQUEST_MAX_REFRESH_INTERVAL_MS)
            : PULL_REQUEST_REFRESH_INTERVAL_MS;
        return { checkedAt: now, pullRequest };
      });
      // Unchanged probe results skip the commit and its repaint; outside a repository every
      // poll finds no status.
      const gitRefresh = yield* createSubscriptionRefresh({
        currentKey,
        interval: Effect.succeed(2_000),
        fetch: fetchGit,
        commit: (gitStatus) =>
          Effect.flatMap(state.getState, (current) =>
            sameGitStatus(current.gitStatus, gitStatus)
              ? Effect.void
              : commit((latest) => ({ ...latest, gitStatus })),
          ),
        spanName: "pi-cosmic-ui.refresh.git",
      });
      const pullRefresh = yield* createSubscriptionRefresh({
        currentKey,
        interval: Effect.succeed(PULL_REQUEST_REFRESH_INTERVAL_MS),
        fetch: fetchPullRequest,
        commit: (value) => {
          if (value === undefined) return Effect.void;
          const checked = (current: CosmicUiLiveState): CosmicUiLiveState => ({
            ...current,
            pullRequestNumber: value.pullRequest?.number,
            pullRequestUrl: value.pullRequest?.url,
            pullRequestCheckedAt: value.checkedAt,
          });
          return Effect.flatMap(state.getState, (current) =>
            current.pullRequestNumber === value.pullRequest?.number &&
            current.pullRequestUrl === value.pullRequest?.url
              ? updateState(checked)
              : commit(checked),
          );
        },
        spanName: "pi-cosmic-ui.refresh.pull-request",
      });
      const refreshGit = Effect.fn("CosmicUiService.refreshGit")(function* (force?: boolean) {
        yield* gitRefresh.request({ force: force === true });
      });
      const installConfig = (next: ResolvedCosmicUiConfig) =>
        commit((current) => ({ ...current, config: next }));
      /**
       * Totals whose usage invalidation and render were requested. An interruption after the state
       * commit leaves them behind, so the next reconciliation repairs the missed notification.
       */
      let notifiedTotals = initialTotals;
      const readUsageTotals =
        options.readUsageTotals ?? createSessionUsageReader(options.sessionManager);
      /**
       * Totals change when the host persists usage, and some of that, such as cache warming, has no
       * event. An unreadable session keeps the last complete totals, which the state already holds.
       */
      const reconcileUsage = Effect.fn("CosmicUiService.reconcileUsage")(function* () {
        if (!isTui()) return;
        // Serialized so an older read cannot replace totals a newer read already committed.
        yield* usageLock.withPermit(
          Effect.gen(function* () {
            const read = readUsageTotals();
            if (read !== undefined && !sameTotals(read, (yield* state.getState).totals))
              yield* updateState((current) => ({ ...current, totals: read }));
            const { totals } = yield* state.getState;
            if (sameTotals(totals, notifiedTotals)) return;
            yield* Effect.sync(() => {
              notifiedTotals = totals;
              if (options.canPublish?.() === false) return;
              options.onUsageChange?.();
              options.onChange();
            });
          }),
        );
      });
      if (isTui() && options.startPolling !== false) {
        yield* gitRefresh.startPolling({}).pipe(Effect.forkScoped);
        yield* pullRefresh.startPolling({}).pipe(Effect.forkScoped);
        yield* reconcileUsage().pipe(
          recoverRefreshFailure("pi-cosmic-ui.usage.reconcile"),
          Effect.schedule(Schedule.spaced(USAGE_RECONCILE_INTERVAL)),
          Effect.forkScoped,
        );
      }
      return {
        refreshGit,
        refreshAll: Effect.fn("CosmicUiService.refreshAll")(function* (force?: boolean) {
          yield* Effect.all([refreshGit(force), pullRefresh.request({ force: force === true })], {
            concurrency: 2,
            discard: true,
          });
        }),
        invalidateProbes: Effect.fn("CosmicUiService.invalidateProbes")(function* () {
          yield* gitRefresh.invalidateWith(
            pullRefresh.invalidateWith(
              updateState((current) => ({
                ...current,
                gitStatus: undefined,
                pullRequestNumber: undefined,
                pullRequestUrl: undefined,
                pullRequestCheckedAt: 0,
                probeRevision: current.probeRevision + 1,
              })),
            ),
          );
          yield* notifyChanged;
        }),
        reconcileUsage,
        updateFooterConfig: Effect.fn("CosmicUiService.updateFooterConfig")(function* (
          patch: FooterPatch,
        ) {
          return yield* settingsLock.withPermit(
            configStore.updateFooter(options.cwd, patch, options.projectTrusted, installConfig),
          );
        }),
        setFooterVisibility: Effect.fn("CosmicUiService.setFooterVisibility")(function* (
          id: string,
          visible: boolean,
        ) {
          return yield* settingsLock.withPermit(
            configStore.setVisibility(
              options.cwd,
              id,
              visible,
              options.projectTrusted,
              installConfig,
            ),
          );
        }),
      };
    }),
  },
) {
  static layer(options: CosmicUiServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
