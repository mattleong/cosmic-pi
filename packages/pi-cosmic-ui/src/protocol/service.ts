import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot, makeFrozenProjection, makeSubscriptionRefresh } from "pi-cosmic-core";
import { HostCallbackBoundary } from "../boundary/host-callback.ts";
import type { PiExecContract } from "../boundary/host-exec.ts";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { type CosmicUiConfigError, CosmicUiConfigStore } from "../config/store.ts";
import type { FooterRepositoryProjection, FooterTotals } from "../footer/builtin-contributions.ts";
import { makeRepositoryProbe } from "../probe/repository-probe.ts";

const PULL_REQUEST_REFRESH_INTERVAL_MS = 30_000;
export const emptyTotals = (): FooterTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});
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
  pullRequestCheckedAt: 0,
  probeRevision: 0,
  homeDirectory: undefined,
});
const immutable = (state: CosmicUiProjection): CosmicUiProjection => freezeSnapshot(state);
export const makeProjection = () =>
  MutableRef.make<CosmicUiProjection>(immutable(initialProjection()));
export const resetProjection = (
  projection: MutableRef.MutableRef<CosmicUiProjection>,
  totals = emptyTotals(),
): void => void MutableRef.set(projection, immutable(initialProjection(totals)));
export interface CosmicUiServiceContract {
  readonly refreshGit: (force?: boolean) => Effect.Effect<void>;
  readonly refreshAll: (force?: boolean) => Effect.Effect<void>;
  readonly invalidateProbes: Effect.Effect<void>;
  readonly setTotals: (totals: FooterTotals) => Effect.Effect<void>;
  readonly updateFooterConfig: (
    patch: Partial<ResolvedCosmicUiConfig["footer"]>,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
  readonly setFooterVisibility: (
    id: string,
    visible: boolean,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
}

export interface CosmicUiServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly exec: PiExecContract;
  readonly initialTotals?: FooterTotals;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly onChange: () => void;
  readonly startPolling?: boolean;
  readonly projectTrusted?: boolean;
}

export class CosmicUiService extends Context.Service<CosmicUiService, CosmicUiServiceContract>()(
  "pi-cosmic-ui/protocol/service/CosmicUiService",
) {
  static make(options: CosmicUiServiceOptions) {
    return Effect.gen(function* () {
      const configStore = yield* CosmicUiConfigStore;
      const probes = makeRepositoryProbe(options.exec);
      const callbacks = yield* HostCallbackBoundary;
      const settingsLock = yield* Semaphore.make(1);
      const home = yield* Config.option(Config.String("HOME"));
      const projectTrusted = options.projectTrusted === true;
      const config = yield* configStore.resolve(options.cwd, projectTrusted);
      const state = yield* makeFrozenProjection<CosmicUiLiveState, CosmicUiProjection>(
        {
          ...initialProjection(),
          totals: options.initialTotals ?? MutableRef.get(options.projection).totals,
          config,
          homeDirectory: Option.getOrUndefined(home),
        },
        (current) => current,
        (published) => MutableRef.set(options.projection, published),
      );
      const updateState = (f: (current: CosmicUiLiveState) => CosmicUiLiveState) =>
        state
          .transition((current) => Effect.succeed([undefined, f(current)] as const))
          .pipe(Effect.orDie);
      // `onChange` is total by construction (invoke-wrapped render requests), so a throw
      // would be a violated invariant, not an expected failure.
      const notifyChanged = Effect.sync(options.onChange);
      let lastKnownCwd = options.cwd;
      const currentCwd = () =>
        callbacks.invoke(
          "host-query",
          () => {
            const cwd = MutableRef.get(options.context).sessionManager.getCwd();
            lastKnownCwd = cwd;
            return cwd;
          },
          lastKnownCwd,
        );
      const currentMode = (ctx: ExtensionContext) =>
        callbacks.invoke<ExtensionContext["mode"]>("host-query", () => ctx.mode, "rpc");
      const currentKey = state.getState.pipe(
        Effect.map((current) => `${currentCwd()}\u0000${current.probeRevision}`),
      );
      const gitRefresh = yield* makeSubscriptionRefresh({
        currentKey,
        interval: Effect.succeed(2_000),
        fetch: () =>
          Effect.gen(function* () {
            const ctx = MutableRef.get(options.context);
            const revision = (yield* state.getState).probeRevision;
            if (currentMode(ctx) !== "tui") {
              currentCwd();
              return undefined;
            }
            const cwd = currentCwd();
            const result = yield* probes
              .git(
                cwd,
                () =>
                  MutableRef.get(options.projection).probeRevision === revision &&
                  currentCwd() === cwd,
              )
              .pipe(Effect.option);
            return Option.getOrUndefined(result);
          }),
        commit: (gitStatus) =>
          updateState((current) => ({ ...current, gitStatus })).pipe(Effect.andThen(notifyChanged)),
        spanName: "pi-cosmic-ui.refresh.git",
      });
      const pullRefresh = yield* makeSubscriptionRefresh({
        currentKey,
        interval: Effect.succeed(PULL_REQUEST_REFRESH_INTERVAL_MS),
        fetch: (request) =>
          Effect.gen(function* () {
            const ctx = MutableRef.get(options.context);
            if (currentMode(ctx) !== "tui") return undefined;
            const current = yield* state.getState;
            const now = yield* Clock.currentTimeMillis;
            if (
              !request.force &&
              now - current.pullRequestCheckedAt < PULL_REQUEST_REFRESH_INTERVAL_MS
            )
              return undefined;
            const cwd = currentCwd();
            const result = yield* probes.pullRequest(cwd).pipe(Effect.option);
            return {
              checkedAt: now,
              number: Option.getOrUndefined(result),
            };
          }),
        commit: (value) =>
          value === undefined
            ? Effect.void
            : updateState((current) => ({
                ...current,
                pullRequestNumber: value.number,
                pullRequestCheckedAt: value.checkedAt,
              })).pipe(Effect.andThen(notifyChanged)),
        spanName: "pi-cosmic-ui.refresh.pull-request",
      });
      const refreshGit = (force = false) => gitRefresh.request({ force });
      const refreshPullRequest = (force = false) => pullRefresh.request({ force });
      const refreshAll = (force = false) =>
        Effect.all([refreshGit(force), refreshPullRequest(force)], {
          concurrency: 2,
          discard: true,
        });
      const invalidate = updateState((current) => ({
        ...current,
        gitStatus: undefined,
        pullRequestNumber: undefined,
        pullRequestCheckedAt: 0,
        probeRevision: current.probeRevision + 1,
      })).pipe(
        Effect.andThen(gitRefresh.invalidate),
        Effect.andThen(pullRefresh.invalidate),
        Effect.andThen(notifyChanged),
      );
      const setTotals = (totals: FooterTotals) =>
        updateState((current) => ({ ...current, totals })).pipe(Effect.andThen(notifyChanged));
      const installConfig = (next: ResolvedCosmicUiConfig) =>
        updateState((current) => ({ ...current, config: next })).pipe(
          Effect.andThen(notifyChanged),
        );
      const updateFooter = (patch: Partial<ResolvedCosmicUiConfig["footer"]>) =>
        settingsLock.withPermits(1)(
          configStore.updateFooter(options.cwd, patch, projectTrusted, installConfig),
        );
      const setVisibility = (id: string, visible: boolean) =>
        settingsLock.withPermits(1)(
          configStore.setVisibility(options.cwd, id, visible, projectTrusted, installConfig),
        );
      if (options.startPolling !== false) {
        yield* gitRefresh.startPolling({}).pipe(Effect.forkScoped);
        yield* pullRefresh.startPolling({}).pipe(Effect.forkScoped);
      }
      return CosmicUiService.of({
        refreshGit,
        refreshAll,
        invalidateProbes: invalidate,
        setTotals,
        updateFooterConfig: updateFooter,
        setFooterVisibility: setVisibility,
      });
    });
  }

  static layer(options: CosmicUiServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
