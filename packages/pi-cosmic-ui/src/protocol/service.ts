import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  freezeSnapshot,
  invokeHostCallback,
  makeFrozenProjection,
  makeSubscriptionRefresh,
} from "pi-cosmic-core";
import type { PiExecContract } from "../boundary/host-exec.ts";
import type { FooterTotals } from "../boundary/host-usage.ts";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { CosmicUiConfigStore, type FooterPatch } from "../config/store.ts";
import type { FooterRepositoryProjection } from "../footer/builtin-contributions.ts";
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
export const makeProjection = () =>
  MutableRef.make<CosmicUiProjection>(freezeSnapshot(initialProjection()));
export const resetProjection = (
  projection: MutableRef.MutableRef<CosmicUiProjection>,
  totals = emptyTotals(),
): void => void MutableRef.set(projection, freezeSnapshot(initialProjection(totals)));

export interface CosmicUiServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly exec: PiExecContract;
  readonly initialTotals?: FooterTotals;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly onChange: () => void;
  readonly canPublish?: (() => boolean) | undefined;
  readonly startPolling?: boolean;
  readonly projectTrusted: boolean;
}

export class CosmicUiService extends Context.Service<CosmicUiService>()(
  "pi-cosmic-ui/protocol/service/CosmicUiService",
  {
    make: Effect.fnUntraced(function* (options: CosmicUiServiceOptions) {
      const configStore = yield* CosmicUiConfigStore;
      const probes = makeRepositoryProbe(options.exec);
      const settingsLock = yield* Semaphore.make(1);
      const home = yield* Config.option(Config.String("HOME"));
      const config = yield* configStore.resolve(options.cwd, options.projectTrusted);
      const state = yield* makeFrozenProjection<CosmicUiLiveState, CosmicUiProjection>(
        {
          ...initialProjection(),
          totals: options.initialTotals ?? MutableRef.get(options.projection).totals,
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
      // `onChange` is total by construction (invoke-wrapped render requests), so a throw
      // would be a violated invariant, not an expected failure.
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
      // Each engine reads this key, and with it the cwd, before every fetch and commit.
      const currentKey = state.getState.pipe(
        Effect.map((current) => `${currentCwd()}\u0000${current.probeRevision}`),
      );
      const gitRefresh = yield* makeSubscriptionRefresh({
        currentKey,
        interval: Effect.succeed(2_000),
        fetch: () =>
          Effect.gen(function* () {
            const revision = (yield* state.getState).probeRevision;
            if (!isTui()) return undefined;
            const cwd = currentCwd();
            return yield* probes
              .git(
                cwd,
                () => state.getSnapshot().probeRevision === revision && currentCwd() === cwd,
              )
              .pipe(Effect.orElseSucceed(() => undefined));
          }),
        commit: (gitStatus) => commit((current) => ({ ...current, gitStatus })),
        spanName: "pi-cosmic-ui.refresh.git",
      });
      const pullRefresh = yield* makeSubscriptionRefresh({
        currentKey,
        interval: Effect.succeed(PULL_REQUEST_REFRESH_INTERVAL_MS),
        fetch: (request) =>
          Effect.gen(function* () {
            if (!isTui()) return undefined;
            const current = yield* state.getState;
            const now = yield* Clock.currentTimeMillis;
            if (
              !request.force &&
              now - current.pullRequestCheckedAt < PULL_REQUEST_REFRESH_INTERVAL_MS
            )
              return undefined;
            const number = yield* probes
              .pullRequest(currentCwd())
              .pipe(Effect.orElseSucceed(() => undefined));
            return { checkedAt: now, number };
          }),
        commit: (value) =>
          value === undefined
            ? Effect.void
            : commit((current) => ({
                ...current,
                pullRequestNumber: value.number,
                pullRequestCheckedAt: value.checkedAt,
              })),
        spanName: "pi-cosmic-ui.refresh.pull-request",
      });
      const refreshGit = (force = false) => gitRefresh.request({ force });
      const installConfig = (next: ResolvedCosmicUiConfig) =>
        commit((current) => ({ ...current, config: next }));
      if (options.startPolling !== false) {
        yield* gitRefresh.startPolling({}).pipe(Effect.forkScoped);
        yield* pullRefresh.startPolling({}).pipe(Effect.forkScoped);
      }
      return {
        refreshGit,
        refreshAll: (force = false) =>
          Effect.all([refreshGit(force), pullRefresh.request({ force })], {
            concurrency: 2,
            discard: true,
          }),
        // Both refresh engines must exclude validation/publication while branch state
        // changes. Commits hold only their own gate; invalidation always takes git then PR.
        invalidateProbes: gitRefresh
          .invalidateWith(
            pullRefresh.invalidateWith(
              updateState((current) => ({
                ...current,
                gitStatus: undefined,
                pullRequestNumber: undefined,
                pullRequestCheckedAt: 0,
                probeRevision: current.probeRevision + 1,
              })),
            ),
          )
          .pipe(Effect.andThen(notifyChanged)),
        setTotals: (totals: FooterTotals) => commit((current) => ({ ...current, totals })),
        updateFooterConfig: (patch: FooterPatch) =>
          settingsLock.withPermit(
            configStore.updateFooter(options.cwd, patch, options.projectTrusted, installConfig),
          ),
        setFooterVisibility: (id: string, visible: boolean) =>
          settingsLock.withPermit(
            configStore.setVisibility(
              options.cwd,
              id,
              visible,
              options.projectTrusted,
              installConfig,
            ),
          ),
      };
    }),
  },
) {
  static layer(options: CosmicUiServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
