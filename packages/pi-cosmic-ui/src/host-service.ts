import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { JsonDocumentStore, PiApi, makeRefreshCoordinator } from "pi-cosmic-core";
import {
  CosmicUiConfigError,
  resolveConfig,
  setFooterVisibility,
  updateFooterConfig,
} from "./config/store.ts";
import type { ResolvedCosmicUiConfig } from "./config/schema.ts";
import { applyGitNumstat, parseGitStatus, type FooterGitStatus } from "./footer/git.ts";
import type { FooterTotals } from "./footer/component.ts";

const GIT_REFRESH_INTERVAL = "2 seconds";
const PULL_REQUEST_REFRESH_INTERVAL_MS = 30_000;

export const emptyTotals = (): FooterTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

export interface CosmicUiProjection {
  readonly config: ResolvedCosmicUiConfig | undefined;
  readonly totals: FooterTotals;
  readonly gitStatus: FooterGitStatus | undefined;
  readonly pullRequestNumber: number | undefined;
  readonly pullRequestCheckedAt: number;
  readonly probeRevision: number;
  readonly homeDirectory: string | undefined;
}

export const makeProjection = () =>
  MutableRef.make<CosmicUiProjection>({
    config: undefined,
    totals: emptyTotals(),
    gitStatus: undefined,
    pullRequestNumber: undefined,
    pullRequestCheckedAt: 0,
    probeRevision: 0,
    homeDirectory: undefined,
  });

export function invalidateProbes(projection: MutableRef.MutableRef<CosmicUiProjection>): void {
  const current = MutableRef.get(projection);
  MutableRef.set(projection, {
    ...current,
    gitStatus: undefined,
    pullRequestNumber: undefined,
    pullRequestCheckedAt: 0,
    probeRevision: current.probeRevision + 1,
  });
}

export class CosmicProbeError extends Schema.TaggedErrorClass<CosmicProbeError>()(
  "CosmicProbeError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CosmicUiServiceShape {
  readonly refreshGit: (force?: boolean) => Effect.Effect<void>;
  readonly refreshPullRequest: (force?: boolean) => Effect.Effect<void>;
  readonly refreshAll: (force?: boolean) => Effect.Effect<void>;
  readonly updateFooterConfig: (
    patch: Partial<ResolvedCosmicUiConfig["footer"]>,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
  readonly setFooterVisibility: (
    id: string,
    visible: boolean,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
}

export class CosmicUiService extends Context.Service<CosmicUiService, CosmicUiServiceShape>()(
  "pi-cosmic-ui/host-service/CosmicUiService",
) {
  static layer(options: {
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly cwd: string;
    readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
    readonly onChange: () => void;
    readonly isCurrent: () => boolean;
    readonly agentDir?: string;
    readonly startPolling?: boolean;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const pi = yield* PiApi;
        const documents = yield* JsonDocumentStore;
        const path = yield* Path.Path;
        const agentDir = options.agentDir ?? getAgentDir();
        const gitCoordinator = yield* makeRefreshCoordinator();
        const pullRequestCoordinator = yield* makeRefreshCoordinator();
        const settingsLock = yield* Semaphore.make(1);
        const home = yield* Config.option(Config.string("HOME"));
        const resolveCurrentConfig = () =>
          resolveConfig(options.cwd, agentDir).pipe(
            Effect.provideService(JsonDocumentStore, documents),
            Effect.provideService(Path.Path, path),
          );
        const config = yield* resolveCurrentConfig();
        MutableRef.set(options.projection, {
          ...MutableRef.get(options.projection),
          config,
          homeDirectory: Option.getOrUndefined(home),
        });

        const notifyChanged = Effect.fn("CosmicUi.notifyChanged")(function* () {
          if (!options.isCurrent()) return;
          yield* Effect.try({
            try: options.onChange,
            catch: () =>
              new CosmicProbeError({ operation: "render", message: "Unable to render Cosmic UI." }),
          }).pipe(Effect.catch(() => Effect.void));
        });
        const exec = Effect.fn("CosmicUi.exec")(function* (
          command: string,
          args: readonly string[],
          cwd: string,
          timeout: number,
        ) {
          return yield* Effect.tryPromise({
            try: (signal) => pi.exec(command, [...args], { cwd, timeout, signal }),
            catch: () =>
              new CosmicProbeError({
                operation: command,
                message: `Unable to inspect ${command === "git" ? "Git" : "pull request"} status.`,
              }),
          });
        });

        const probeIsCurrent = (cwd: string, revision: number) =>
          options.isCurrent() &&
          MutableRef.get(options.projection).probeRevision === revision &&
          MutableRef.get(options.context).sessionManager.getCwd() === cwd;

        const refreshGitOnce = Effect.fn("CosmicUi.refreshGitOnce")(function* () {
          const ctx = MutableRef.get(options.context);
          if (ctx.mode !== "tui" || !options.isCurrent()) return;
          const cwd = ctx.sessionManager.getCwd();
          const revision = MutableRef.get(options.projection).probeRevision;
          const result = yield* exec(
            "git",
            ["status", "--short", "--branch", "--untracked-files=normal"],
            cwd,
            2_000,
          ).pipe(Effect.catch(() => Effect.void));
          if (!probeIsCurrent(cwd, revision)) return;
          let next = result?.code === 0 ? parseGitStatus(result.stdout) : undefined;
          if (next && next.staged + next.modified + next.conflicts > 0) {
            const diff = yield* exec("git", ["diff", "--numstat", "HEAD", "--"], cwd, 2_000).pipe(
              Effect.catch(() => Effect.void),
            );
            if (!probeIsCurrent(cwd, revision)) return;
            if (diff?.code === 0) next = applyGitNumstat(next, diff.stdout);
          }
          const current = MutableRef.get(options.projection);
          if (sameGitStatus(current.gitStatus, next)) return;
          MutableRef.set(options.projection, { ...current, gitStatus: next });
          yield* notifyChanged();
        });

        const refreshPullRequestOnce = Effect.fn("CosmicUi.refreshPullRequestOnce")(function* (
          force: boolean,
        ) {
          const ctx = MutableRef.get(options.context);
          if (ctx.mode !== "tui" || !options.isCurrent()) return;
          const cwd = ctx.sessionManager.getCwd();
          const now = yield* Clock.currentTimeMillis;
          const current = MutableRef.get(options.projection);
          const revision = current.probeRevision;
          if (!force && now - current.pullRequestCheckedAt < PULL_REQUEST_REFRESH_INTERVAL_MS)
            return;
          const result = yield* exec(
            "gh",
            ["pr", "view", "--json", "number", "--jq", ".number"],
            cwd,
            3_000,
          ).pipe(Effect.catch(() => Effect.void));
          if (!probeIsCurrent(cwd, revision)) return;
          const parsed = Number(result?.stdout.trim());
          const next =
            result?.code === 0 && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
          const latest = MutableRef.get(options.projection);
          MutableRef.set(options.projection, {
            ...latest,
            pullRequestNumber: next,
            pullRequestCheckedAt: now,
          });
          if (latest.pullRequestNumber !== next) yield* notifyChanged();
        });

        const refreshGit = (force = false) => gitCoordinator.run({ force }, () => refreshGitOnce());
        const refreshPullRequest = (force = false) =>
          pullRequestCoordinator.run({ force }, (request) =>
            refreshPullRequestOnce(request.force === true),
          );
        const refreshAll = (force = false) =>
          Effect.all([refreshGit(force), refreshPullRequest(force)], {
            concurrency: "unbounded",
            discard: true,
          });
        const currentConfig = () => {
          const current = MutableRef.get(options.projection).config;
          return current
            ? Effect.succeed(current)
            : Effect.fail(
                new CosmicUiConfigError({
                  operation: "update",
                  path: "unknown",
                  message: "Cosmic UI session has not started.",
                }),
              );
        };
        const installConfig = (next: ResolvedCosmicUiConfig) =>
          Effect.sync(() => {
            MutableRef.set(options.projection, {
              ...MutableRef.get(options.projection),
              config: next,
            });
          }).pipe(Effect.andThen(notifyChanged()), Effect.as(next));
        const updateConfig = (patch: Partial<ResolvedCosmicUiConfig["footer"]>) =>
          settingsLock.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* currentConfig();
              const next = yield* updateFooterConfig(options.cwd, agentDir, current, patch).pipe(
                Effect.provideService(JsonDocumentStore, documents),
                Effect.provideService(Path.Path, path),
              );
              return yield* installConfig(next);
            }),
          );
        const updateVisibility = (id: string, visible: boolean) =>
          settingsLock.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* currentConfig();
              const next = yield* setFooterVisibility(
                options.cwd,
                agentDir,
                current,
                id,
                visible,
              ).pipe(
                Effect.provideService(JsonDocumentStore, documents),
                Effect.provideService(Path.Path, path),
              );
              return yield* installConfig(next);
            }),
          );

        if (options.startPolling !== false) {
          yield* Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(GIT_REFRESH_INTERVAL);
              yield* refreshAll();
            }
          }).pipe(Effect.forkScoped);
        }
        return CosmicUiService.of({
          refreshGit,
          refreshPullRequest,
          refreshAll,
          updateFooterConfig: updateConfig,
          setFooterVisibility: updateVisibility,
        });
      }),
    );
  }
}

function sameGitStatus(left: FooterGitStatus | undefined, right: FooterGitStatus | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.staged === right.staged &&
    left.modified === right.modified &&
    left.untracked === right.untracked &&
    left.conflicts === right.conflicts &&
    left.ahead === right.ahead &&
    left.behind === right.behind &&
    left.linesAdded === right.linesAdded &&
    left.linesRemoved === right.linesRemoved &&
    left.linesChanged === right.linesChanged
  );
}
