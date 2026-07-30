import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot, ProcessCoordinator } from "pi-cosmic-core";
import { HerdrClient, type HerdrClientShape } from "../boundary/herdr-client.ts";
import { ReportChannel } from "../boundary/report-channel.ts";
import { withHerdrStateLock } from "../boundary/state-lock.ts";
import {
  HERDR_MANAGED_TAB_LABEL,
  type PersistedHerdrProject,
  type PersistedHerdrRun,
} from "../config/schema.ts";
import { HerdrConfigStore } from "../config/store.ts";
import {
  displayName,
  guidancePrompt,
  nextDisplayOrdinal,
  normalizeTask,
  paneLabel,
  persistedRun,
  splitTarget,
  taskPrompt,
} from "./coordination.ts";
import {
  HerdrAgentNotFoundError,
  HerdrOwnershipError,
  HerdrRuntimeClosedError,
  InvalidHerdrRequestError,
  type HerdrError,
} from "./errors.ts";
import {
  isHerdrAgentFinished,
  type HerdrAgentReadResult,
  type HerdrAgentView,
  type HerdrAwaitUntil,
  type HerdrProjection,
  type HerdrReadSource,
  type HerdrSnapshot,
  type StartHerdrAgentRequest,
} from "./model.ts";
import { sortHerdrAgents } from "./projection.ts";
import { refreshHerdrRecords } from "./reconcile.ts";
import {
  acquireManagedProject,
  persistedProjectIsLive,
  type ManagedHerdrProject,
} from "./workspace.ts";

const MAX_GUIDANCE_CHARS = 16_384;
const PANE_READY_RETRIES = 50;
const PANE_READY_RETRY_DELAY = "100 millis";

export interface HerdrServiceShape {
  readonly start: (request: StartHerdrAgentRequest) => Effect.Effect<HerdrAgentView, HerdrError>;
  readonly list: Effect.Effect<ReadonlyArray<HerdrAgentView>>;
  readonly status: (id: string) => Effect.Effect<HerdrAgentView, HerdrAgentNotFoundError>;
  readonly await: (
    ids: ReadonlyArray<string>,
    until: HerdrAwaitUntil,
    onUpdate?: ((agents: ReadonlyArray<HerdrAgentView>) => void) | undefined,
  ) => Effect.Effect<ReadonlyArray<HerdrAgentView>, HerdrError>;
  readonly read: (
    id: string,
    source: HerdrReadSource,
    lines: number,
  ) => Effect.Effect<HerdrAgentReadResult, HerdrError>;
  readonly send: (id: string, message: string) => Effect.Effect<HerdrAgentView, HerdrError>;
  readonly stop: (id: string) => Effect.Effect<HerdrAgentView, HerdrError>;
  readonly focus: (id: string) => Effect.Effect<void, HerdrError>;
  readonly projection: Effect.Effect<HerdrProjection>;
}

export interface HerdrServiceOptions {
  readonly cwd: string;
  readonly publish?: ((projection: HerdrProjection) => void) | undefined;
}

const notFound = (id: string) =>
  new HerdrAgentNotFoundError({ id, message: `Herdr agent run not found: ${id}` });

const restoreRun = (
  run: PersistedHerdrRun,
  session: string,
  state: HerdrAgentView["state"] = run.state,
): HerdrAgentView => ({
  id: run.id,
  name: run.name,
  agentName: run.agentName,
  task: run.task,
  cwd: run.cwd,
  state,
  ...(run.remoteStatus === undefined ? {} : { remoteStatus: run.remoteStatus }),
  session,
  workspaceId: run.workspaceId,
  tabId: run.tabId,
  paneId: run.paneId,
  ...(run.terminalId ? { terminalId: run.terminalId } : {}),
  reportGeneration: run.reportGeneration,
  ...(run.report === undefined ? {} : { report: run.report }),
  ...(run.error === undefined ? {} : { error: run.error }),
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
});

const shouldImportPersisted = (
  current: HerdrAgentView | undefined,
  persisted: PersistedHerdrRun,
): boolean => {
  if (!current) return true;
  if (current.state === "stopped")
    return persisted.state === "stopped" && persisted.updatedAt > current.updatedAt;
  if (persisted.state === "stopped") return true;
  const currentFinished = isHerdrAgentFinished(current.state);
  const persistedFinished = isHerdrAgentFinished(persisted.state);
  if (currentFinished !== persistedFinished) return persistedFinished;
  return persisted.updatedAt > current.updatedAt;
};

const makeService = Effect.fn("HerdrService.make")(function* (options: HerdrServiceOptions) {
  const client = yield* HerdrClient;
  const reports = yield* ReportChannel;
  const store = yield* HerdrConfigStore;
  const path = yield* Path.Path;
  const coordinator = yield* ProcessCoordinator;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const cwd = path.resolve(options.cwd);
  const sessionLabel = store.config.session ?? "current";
  const projectKey = `${client.sessionIdentity}\u0000${cwd}`;
  const records = new Map<string, HerdrAgentView>();
  let project: ManagedHerdrProject | undefined;
  let revision = 0;
  let revisionWake = Deferred.makeUnsafe<void>();
  let closed = false;

  const withLock = lock.withPermits(1);
  const snapshotProjection = (): HerdrProjection => ({
    revision,
    agents: sortHerdrAgents([...records.values()].map((agent) => ({ ...agent }))),
  });
  const publish = () => {
    revision += 1;
    const wake = revisionWake;
    revisionWake = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(wake, Effect.void);
    try {
      options.publish?.(freezeSnapshot(snapshotProjection()));
    } catch {
      // Host projection failures cannot own persistent Herdr resources.
    }
  };

  const projectFromPersisted = (persisted: PersistedHerdrProject): ManagedHerdrProject => ({
    workspaceId: persisted.workspaceId,
    workspaceOwned: persisted.workspaceOwned,
    tabId: persisted.tabId,
    anchorPaneId: persisted.anchorPaneId,
  });
  const persistedProject = (): PersistedHerdrProject | undefined =>
    project
      ? {
          key: projectKey,
          session: client.sessionIdentity,
          cwd,
          workspaceId: project.workspaceId,
          workspaceOwned: project.workspaceOwned,
          tabId: project.tabId,
          tabLabel: HERDR_MANAGED_TAB_LABEL,
          anchorPaneId: project.anchorPaneId,
          runs: [...records.values()].map(persistedRun),
        }
      : undefined;

  const persist = (removeRunIds: ReadonlyArray<string> = []) => {
    const current = persistedProject();
    return current ? store.saveProject(current, { removeRunIds }) : Effect.void;
  };
  const stateLockKey = `${store.statePath}.operations`;
  const withStateLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    coordinator.withLock(stateLockKey, withHerdrStateLock(stateLockKey, effect));
  const startClaudeWhenReady: HerdrClientShape["startClaude"] = (input) => {
    const attempt = (remaining: number): ReturnType<HerdrClientShape["startClaude"]> =>
      client
        .startClaude(input)
        .pipe(
          Effect.catch((error) =>
            error._tag === "HerdrCommandError" && error.code === "agent_pane_busy" && remaining > 0
              ? Effect.sleep(PANE_READY_RETRY_DELAY).pipe(Effect.andThen(attempt(remaining - 1)))
              : Effect.fail(error),
          ),
        );
    return attempt(PANE_READY_RETRIES);
  };
  const closePanePreservingFocus = (paneId: string, targetTabId: string, before?: HerdrSnapshot) =>
    Effect.gen(function* () {
      const previous = before ?? (yield* client.snapshot);
      yield* client.closePane(paneId);
      const previousTabId = previous.focusedTabId;
      if (!previousTabId || previousTabId === targetTabId) return;
      yield* Effect.gen(function* () {
        const after = yield* client.snapshot;
        if (
          after.focusedTabId === targetTabId &&
          after.tabs.some((tab) => tab.tabId === previousTabId)
        )
          yield* client.focusTab(previousTabId);
      }).pipe(Effect.catch(() => Effect.void));
    });
  const ensureManagedProject = Effect.fn("HerdrService.ensureManagedProject")(function* () {
    const current = persistedProject();
    const snapshot = yield* client.snapshot;
    if (project && persistedProjectIsLive(current, snapshot)) return { project, snapshot };
    const acquired = yield* acquireManagedProject({
      client,
      cwd,
      workspaceLabel: `${path.basename(cwd) || "project"} · pi-herdr`,
      snapshot,
      ...(current ? { persisted: current } : {}),
    });
    project = acquired;
    yield* persist();
    return { project: acquired, snapshot: yield* client.snapshot };
  });
  if (!store.config.enabled)
    return yield* new HerdrRuntimeClosedError({
      message: "pi-herdr is disabled by configuration.",
    });
  yield* client.preflight;
  yield* withStateLock(
    Effect.gen(function* () {
      const initialPersisted = yield* store.loadProject(projectKey);
      const initialSnapshot = yield* client.snapshot;
      const persistedWasLive = persistedProjectIsLive(initialPersisted, initialSnapshot);
      if (initialPersisted) {
        project = projectFromPersisted(initialPersisted);
        for (const run of initialPersisted.runs) {
          records.set(
            run.id,
            restoreRun(
              run,
              sessionLabel,
              persistedWasLive || isHerdrAgentFinished(run.state) ? run.state : "unknown",
            ),
          );
        }
      }
    }),
  );

  const importSharedRuns = Effect.fn("HerdrService.importSharedRuns")(function* () {
    let imported = false;
    const shared = yield* store.loadProject(projectKey);
    if (shared && !project) project = projectFromPersisted(shared);
    if (
      shared &&
      project &&
      shared.workspaceId === project.workspaceId &&
      shared.tabId === project.tabId &&
      shared.anchorPaneId === project.anchorPaneId
    ) {
      for (const persisted of shared.runs) {
        const current = records.get(persisted.id);
        if (shouldImportPersisted(current, persisted)) {
          records.set(persisted.id, restoreRun(persisted, sessionLabel));
          imported = true;
        }
      }
    }
    return imported;
  });

  const refresh = Effect.fn("HerdrService.refresh")(() =>
    withStateLock(
      withLock(
        Effect.gen(function* () {
          const imported = yield* importSharedRuns();
          const result = yield* refreshHerdrRecords({
            client,
            reports,
            records,
            maxRetained: store.config.maxRetained,
          });
          if (imported || result.changed) {
            yield* Effect.forEach(result.evictedIds, reports.remove, { discard: true }).pipe(
              Effect.ignore,
            );
            yield* persist(result.evictedIds);
            publish();
          }
        }),
      ),
    ),
  );

  const monitor = refresh().pipe(
    Effect.catchCause(() => Effect.void),
    Effect.andThen(Effect.sleep(`${store.config.pollIntervalMs} millis`)),
    Effect.forever,
  );
  yield* monitor.pipe(Effect.forkIn(ownerScope, { startImmediately: true }));

  const requireRun = (id: string): Effect.Effect<HerdrAgentView, HerdrAgentNotFoundError> =>
    Effect.suspend(() => {
      const run = records.get(id);
      return run ? Effect.succeed(run) : Effect.fail(notFound(id));
    });

  const start: HerdrServiceShape["start"] = (request) =>
    withStateLock(
      withLock(
        Effect.gen(function* () {
          if (closed) return yield* new HerdrRuntimeClosedError({ message: "pi-herdr is closed." });
          const task = normalizeTask(request.task);
          if (!task)
            return yield* new InvalidHerdrRequestError({
              code: "task_required",
              message: "Herdr agent task must not be empty.",
            });
          const imported = yield* importSharedRuns();
          if (imported) publish();
          const managed = yield* ensureManagedProject();
          const channel = yield* reports.prepare;
          const now = yield* Clock.currentTimeMillis;
          const name = displayName(request.name, nextDisplayOrdinal(records.values()));
          const target = splitTarget(
            managed.snapshot,
            managed.project.tabId,
            managed.project.anchorPaneId,
          );
          const pane = yield* client
            .splitPane(target.paneId, cwd, target.direction)
            .pipe(Effect.onError(() => reports.remove(channel.runId)));
          const provisional: HerdrAgentView = {
            id: channel.runId,
            name,
            agentName: channel.agentName,
            task,
            cwd,
            state: "starting",
            session: sessionLabel,
            workspaceId: managed.project.workspaceId,
            tabId: managed.project.tabId,
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            reportGeneration: channel.generation,
            startedAt: now,
            updatedAt: now,
          };
          records.set(provisional.id, provisional);
          yield* persist();
          publish();
          const rollback = Effect.gen(function* () {
            yield* closePanePreservingFocus(pane.paneId, managed.project.tabId).pipe(
              Effect.catch(() => Effect.void),
            );
            records.delete(provisional.id);
            yield* persist([provisional.id]).pipe(Effect.catch(() => Effect.void));
            publish();
            yield* reports.remove(channel.runId);
          });
          yield* client
            .renamePane(pane.paneId, paneLabel(name))
            .pipe(Effect.onError(() => rollback));
          const remote = yield* startClaudeWhenReady({
            paneId: pane.paneId,
            name: channel.agentName,
            mcpConfigPath: channel.mcpConfigPath,
          }).pipe(Effect.onError(() => rollback));
          const created: HerdrAgentView = {
            ...provisional,
            remoteStatus: remote.agentStatus,
            terminalId: remote.terminalId,
          };
          records.set(created.id, created);
          yield* persist();
          publish();
          const promptOutcome = yield* client
            .prompt(created.agentName, taskPrompt(task))
            .pipe(Effect.exit);
          const promptTime = yield* Clock.currentTimeMillis;
          const updated: HerdrAgentView = Exit.isSuccess(promptOutcome)
            ? {
                ...created,
                state:
                  promptOutcome.value.agentStatus === "blocked"
                    ? "blocked"
                    : promptOutcome.value.agentStatus === "unknown"
                      ? "unknown"
                      : promptOutcome.value.agentStatus === "working"
                        ? "working"
                        : "starting",
                remoteStatus: promptOutcome.value.agentStatus,
                terminalId: promptOutcome.value.terminalId,
                updatedAt: promptTime,
              }
            : {
                ...created,
                state: "blocked",
                error:
                  "Claude Code started, but pi-herdr could not submit its task. Inspect the pane, retry with guidance, or stop it.",
                updatedAt: promptTime,
              };
          records.set(updated.id, updated);
          yield* persist();
          publish();
          return { ...updated };
        }),
      ),
    );

  const list: HerdrServiceShape["list"] = withLock(
    Effect.sync(() => sortHerdrAgents([...records.values()].map((run) => ({ ...run })))),
  );

  const status: HerdrServiceShape["status"] = (id) =>
    withLock(requireRun(id).pipe(Effect.map((run) => ({ ...run }))));

  const awaitRuns: HerdrServiceShape["await"] = (ids, until, onUpdate) => {
    const selectedIds = [...new Set(ids)];
    if (selectedIds.length === 0)
      return Effect.fail(
        new InvalidHerdrRequestError({
          code: "run_ids_required",
          message: "herdr_agent_await requires at least one run ID.",
        }),
      );
    const loop: Effect.Effect<ReadonlyArray<HerdrAgentView>, HerdrError> = Effect.suspend(() =>
      withLock(
        Effect.gen(function* () {
          if (closed) return yield* new HerdrRuntimeClosedError({ message: "pi-herdr is closed." });
          const selected: HerdrAgentView[] = [];
          for (const id of selectedIds) selected.push(yield* requireRun(id));
          const snapshot = selected.map((run) => ({ ...run }));
          yield* Effect.try({
            try: () => onUpdate?.(snapshot),
            catch: () => "progress_callback_failed" as const,
          }).pipe(Effect.catch(() => Effect.void));
          const attention = snapshot.some((run) => run.state === "blocked");
          const finished = snapshot.filter((run) => isHerdrAgentFinished(run.state)).length;
          const done =
            attention || (until === "all_finished" ? finished === snapshot.length : finished > 0);
          return { done, snapshot, wake: revisionWake };
        }),
      ).pipe(
        Effect.flatMap((result) =>
          result.done
            ? Effect.succeed(result.snapshot)
            : Deferred.await(result.wake).pipe(Effect.andThen(loop)),
        ),
      ),
    );
    return loop;
  };

  const read: HerdrServiceShape["read"] = (id, source, lines) =>
    withLock(
      Effect.gen(function* () {
        const run = yield* requireRun(id);
        const text = yield* client.readAgent(run.agentName, source, lines);
        return { id, source, text };
      }),
    );

  const send: HerdrServiceShape["send"] = (id, message) =>
    withStateLock(
      withLock(
        Effect.gen(function* () {
          if (closed) return yield* new HerdrRuntimeClosedError({ message: "pi-herdr is closed." });
          const imported = yield* importSharedRuns();
          if (imported) publish();
          const run = yield* requireRun(id);
          if (isHerdrAgentFinished(run.state) || run.report !== undefined)
            return yield* new InvalidHerdrRequestError({
              code: "run_finished",
              message:
                "Herdr runs with a final report cannot accept more guidance; start a new Claude agent.",
            });
          const guidance = message.trim().slice(0, MAX_GUIDANCE_CHARS);
          if (!guidance)
            return yield* new InvalidHerdrRequestError({
              code: "message_required",
              message: "Herdr guidance must not be empty.",
            });
          const remote = yield* client.prompt(run.agentName, guidancePrompt(guidance));
          const updated = {
            ...run,
            state:
              remote.agentStatus === "blocked"
                ? "blocked"
                : remote.agentStatus === "unknown"
                  ? "unknown"
                  : "working",
            remoteStatus: remote.agentStatus,
            updatedAt: yield* Clock.currentTimeMillis,
          } satisfies HerdrAgentView;
          records.set(id, updated);
          yield* persist();
          publish();
          return { ...updated };
        }),
      ),
    );

  const stop: HerdrServiceShape["stop"] = (id) =>
    withStateLock(
      withLock(
        Effect.gen(function* () {
          if (closed) return yield* new HerdrRuntimeClosedError({ message: "pi-herdr is closed." });
          const imported = yield* importSharedRuns();
          if (imported) publish();
          const run = yield* requireRun(id);
          if (run.state === "stopped") return { ...run };
          const snapshot = yield* client.snapshot;
          const pane = snapshot.panes.find((candidate) => candidate.paneId === run.paneId);
          if (
            pane &&
            (pane.tabId !== run.tabId ||
              pane.workspaceId !== run.workspaceId ||
              (run.terminalId !== undefined && pane.terminalId !== run.terminalId))
          )
            return yield* new HerdrOwnershipError({
              code: "owned_pane_mismatch",
              message: "The Herdr pane ID now belongs to a different resource and was not closed.",
            });
          if (pane) yield* closePanePreservingFocus(run.paneId, run.tabId, snapshot);
          const now = yield* Clock.currentTimeMillis;
          const updated = {
            ...run,
            state: "stopped" as const,
            updatedAt: now,
            completedAt: now,
          };
          records.set(id, updated);
          yield* persist();
          publish();
          yield* reports.remove(id);
          return { ...updated };
        }),
      ),
    );

  const focus: HerdrServiceShape["focus"] = (id) =>
    withLock(
      Effect.gen(function* () {
        const run = yield* requireRun(id);
        yield* client.focusAgent(run.agentName);
      }),
    );

  const projection = withLock(Effect.sync(() => freezeSnapshot(snapshotProjection())));
  publish();

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
        const wake = revisionWake;
        revisionWake = Deferred.makeUnsafe<void>();
        Deferred.doneUnsafe(wake, Effect.void);
      }),
    ),
  );

  return HerdrService.of({
    start,
    list,
    status,
    await: awaitRuns,
    read,
    send,
    stop,
    focus,
    projection,
  });
});

export class HerdrService extends Context.Service<HerdrService, HerdrServiceShape>()(
  "pi-herdr/herd/service/HerdrService",
) {
  static readonly layer = (options: HerdrServiceOptions) =>
    Layer.effect(this, makeService(options));

  static override readonly use = <A, E>(f: (service: HerdrServiceShape) => Effect.Effect<A, E>) =>
    Effect.flatMap(this, f);
}
