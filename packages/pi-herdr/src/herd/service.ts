import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot, ProcessCoordinator } from "pi-cosmic-core";
import { AgentHarness } from "../boundary/agent-harness.ts";
import { HerdrClient } from "../boundary/herdr-client.ts";
import { ReportChannel } from "../boundary/report-channel.ts";
import { withHerdrStateLock } from "../boundary/state-lock.ts";
import {
  HERDR_LEGACY_MANAGED_TAB_LABEL,
  HERDR_MANAGED_TAB_LABEL,
  type PersistedHerdrProject,
  type PersistedHerdrRun,
} from "../config/schema.ts";
import { HerdrConfigStore } from "../config/store.ts";
import {
  displayName,
  guidancePrompt,
  matchesOwnedAgent,
  nextDisplayOrdinal,
  normalizeModel,
  normalizeTask,
  paneLabel,
  persistedRun,
  splitTarget,
  taskPrompt,
} from "./coordination.ts";
import {
  HerdrAgentNotFoundError,
  HerdrCommandError,
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
  type HerdrPaneInfo,
  type HerdrReadSource,
  type HerdrRemoteAgentInfo,
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
const TRANSIENT_START_RETRIES = 2;
const INTERACTIVE_READY_RETRIES = 300;
const INTERACTIVE_READY_DELAY = "200 millis";

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
  new HerdrAgentNotFoundError({
    id,
    message: `Herdr agent run not found: ${id}. Use herdr_agent_list to refresh managed run IDs.`,
  });

const restoreRun = (
  run: PersistedHerdrRun,
  session: string,
  state: HerdrAgentView["state"] = run.state,
): HerdrAgentView => ({
  id: run.id,
  kind: run.kind,
  ...(run.model === undefined ? {} : { model: run.model }),
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
  if (current.kind !== persisted.kind || current.model !== persisted.model) return false;
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
  const harnesses = yield* AgentHarness;
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
    tabLabel: persisted.tabLabel,
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
          tabLabel: project.tabLabel,
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
  const restorePreviousTabFocus = (previous: HerdrSnapshot, targetTabId: string) => {
    const previousTabId = previous.focusedTabId;
    if (!previousTabId || previousTabId === targetTabId) return Effect.void;
    return Effect.gen(function* () {
      const after = yield* client.snapshot;
      if (
        after.focusedTabId === targetTabId &&
        after.tabs.some((tab) => tab.tabId === previousTabId)
      )
        yield* client.focusTab(previousTabId);
    }).pipe(Effect.catch(() => Effect.void));
  };
  const closePanePreservingFocus = (paneId: string, targetTabId: string, before?: HerdrSnapshot) =>
    Effect.gen(function* () {
      const previous = before ?? (yield* client.snapshot);
      yield* client.closePane(paneId);
      yield* restorePreviousTabFocus(previous, targetTabId);
    });
  const exactOwnedPane = (run: HerdrAgentView, snapshot: HerdrSnapshot) =>
    run.terminalId === undefined
      ? undefined
      : snapshot.panes.find(
          (candidate) =>
            candidate.paneId === run.paneId &&
            candidate.workspaceId === run.workspaceId &&
            candidate.tabId === run.tabId &&
            candidate.terminalId === run.terminalId,
        );
  const exactOwnedRemote = (run: HerdrAgentView, snapshot: HerdrSnapshot) => {
    if (!exactOwnedPane(run, snapshot)) return undefined;
    return snapshot.agents.find((candidate) => matchesOwnedAgent(run, candidate));
  };
  const ownershipMismatch = (message: string) =>
    new HerdrOwnershipError({ code: "owned_agent_mismatch", message });
  const waitForInteractive = (
    run: HerdrAgentView,
    initial: HerdrRemoteAgentInfo,
  ): Effect.Effect<HerdrRemoteAgentInfo, HerdrError> => {
    const isReady = (remote: HerdrRemoteAgentInfo): boolean => remote.interactiveReady === true;
    if (isReady(initial)) return Effect.succeed(initial);
    const attempt = (remaining: number): Effect.Effect<HerdrRemoteAgentInfo, HerdrError> =>
      client.snapshot.pipe(
        Effect.flatMap((snapshot) => {
          const remote = exactOwnedRemote(run, snapshot);
          if (remote !== undefined && isReady(remote)) return Effect.succeed(remote);
          if (remaining <= 0)
            return Effect.fail(
              new HerdrCommandError({
                operation: `wait for ${run.kind} interactive readiness`,
                code: "agent_not_interactive",
                message: "The managed agent did not become ready to receive its task in time.",
              }),
            );
          return Effect.sleep(INTERACTIVE_READY_DELAY).pipe(Effect.andThen(attempt(remaining - 1)));
        }),
      );
    return attempt(INTERACTIVE_READY_RETRIES);
  };
  const ensureManagedProject = Effect.fn("HerdrService.ensureManagedProject")(function* () {
    const current = persistedProject();
    const snapshot = yield* client.snapshot;
    if (project && persistedProjectIsLive(current, snapshot)) {
      if (project.tabLabel === HERDR_LEGACY_MANAGED_TAB_LABEL) {
        yield* client.renameTab(project.tabId, HERDR_MANAGED_TAB_LABEL);
        project = { ...project, tabLabel: HERDR_MANAGED_TAB_LABEL };
        yield* persist();
        return { project, snapshot: yield* client.snapshot };
      }
      return { project, snapshot };
    }
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
  const moveAnchorBeforeClose = Effect.fn("HerdrService.moveAnchorBeforeClose")(function* (input: {
    readonly closingRunId: string;
    readonly pane: HerdrPaneInfo;
    readonly snapshot: HerdrSnapshot;
  }) {
    if (!project || project.anchorPaneId !== input.pane.paneId) return;
    let replacement: HerdrPaneInfo | undefined = [...records.values()]
      .filter(
        (run) =>
          run.id !== input.closingRunId &&
          run.state !== "stopped" &&
          run.workspaceId === input.pane.workspaceId &&
          run.tabId === input.pane.tabId,
      )
      .map((run) => exactOwnedRemote(run, input.snapshot))
      .find((candidate) => candidate !== undefined);
    if (!replacement) replacement = yield* client.splitPane(input.pane.paneId, cwd, "right");
    project = { ...project, anchorPaneId: replacement.paneId };
    yield* persist();
  });
  const closeReportedTerminalPanes = Effect.fn("HerdrService.closeReportedTerminalPanes")(
    function* () {
      const candidates = [...records.values()].filter(
        (run) => run.report !== undefined && (run.state === "completed" || run.state === "failed"),
      );
      for (const run of candidates) {
        const snapshot = yield* client.snapshot;
        const pane = exactOwnedRemote(run, snapshot);
        if (!pane) continue;
        yield* moveAnchorBeforeClose({ closingRunId: run.id, pane, snapshot });
        yield* closePanePreservingFocus(run.paneId, run.tabId, snapshot);
        yield* reports.remove(run.id);
      }
    },
  );
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
    if (shared) {
      const sharedProject = projectFromPersisted(shared);
      if (
        !project ||
        project.workspaceId !== sharedProject.workspaceId ||
        project.workspaceOwned !== sharedProject.workspaceOwned ||
        project.tabId !== sharedProject.tabId ||
        project.tabLabel !== sharedProject.tabLabel ||
        project.anchorPaneId !== sharedProject.anchorPaneId
      ) {
        project = sharedProject;
        imported = true;
      }
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
          yield* closeReportedTerminalPanes();
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

  const start: HerdrServiceShape["start"] = (request) => {
    const attempt = (remaining: number): ReturnType<HerdrServiceShape["start"]> =>
      withStateLock(
        withLock(
          Effect.gen(function* () {
            if (closed)
              return yield* new HerdrRuntimeClosedError({ message: "pi-herdr is closed." });
            const task = normalizeTask(request.task);
            if (!task)
              return yield* new InvalidHerdrRequestError({
                code: "task_required",
                message: "Herdr agent task must not be empty.",
              });
            const model = normalizeModel(request.model);
            if (!model)
              return yield* new InvalidHerdrRequestError({
                code: "model_invalid",
                message:
                  "Herdr agent model must be non-empty, contain no control characters, and not begin with a dash.",
              });
            const imported = yield* importSharedRuns();
            if (imported) publish();
            const activeCount = [...records.values()].filter(
              (run) => !isHerdrAgentFinished(run.state),
            ).length;
            if (activeCount >= store.config.maxActive)
              return yield* new InvalidHerdrRequestError({
                code: "active_limit_reached",
                message: `pi-herdr already manages the configured limit of ${store.config.maxActive} active or inspectable agents. Stop an existing run before starting another.`,
              });
            const managed = yield* ensureManagedProject();
            const channel = yield* reports.prepare;
            const harness = yield* harnesses
              .prepare(request.kind, cwd, channel)
              .pipe(Effect.onError(() => reports.remove(channel.runId)));
            const now = yield* Clock.currentTimeMillis;
            const name = displayName(
              request.kind,
              request.name,
              nextDisplayOrdinal(request.kind, records.values()),
            );
            const anchorPane = managed.snapshot.panes.find(
              (candidate) =>
                candidate.paneId === managed.project.anchorPaneId &&
                candidate.workspaceId === managed.project.workspaceId &&
                candidate.tabId === managed.project.tabId,
            );
            const anchorClaimed = [...records.values()].some(
              (run) => run.paneId === managed.project.anchorPaneId,
            );
            const anchorHasAgent = managed.snapshot.agents.some(
              (agent) => agent.paneId === managed.project.anchorPaneId,
            );
            let pane: HerdrPaneInfo;
            let paneWasSplit = false;
            if (anchorPane && !anchorClaimed && !anchorHasAgent) pane = anchorPane;
            else {
              const target = splitTarget(
                managed.snapshot,
                managed.project.tabId,
                managed.project.anchorPaneId,
              );
              pane = yield* client
                .splitPane(target.paneId, cwd, target.direction)
                .pipe(Effect.onError(() => reports.remove(channel.runId)));
              paneWasSplit = true;
            }
            const provisional: HerdrAgentView = {
              id: channel.runId,
              kind: request.kind,
              model,
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
              yield* Effect.gen(function* () {
                const snapshot = yield* client.snapshot;
                const owned = snapshot.panes.find(
                  (candidate) =>
                    candidate.paneId === pane.paneId &&
                    candidate.workspaceId === provisional.workspaceId &&
                    candidate.tabId === provisional.tabId &&
                    candidate.terminalId === provisional.terminalId,
                );
                if (!owned) return;
                const occupants = snapshot.agents.filter(
                  (candidate) => candidate.paneId === provisional.paneId,
                );
                if (
                  occupants.some(
                    (candidate) =>
                      candidate.terminalId !== provisional.terminalId ||
                      candidate.name !== provisional.agentName,
                  )
                )
                  return;
                if (!paneWasSplit)
                  yield* moveAnchorBeforeClose({
                    closingRunId: provisional.id,
                    pane: owned,
                    snapshot,
                  });
                yield* closePanePreservingFocus(owned.paneId, provisional.tabId, snapshot);
              }).pipe(Effect.catch(() => Effect.void));
              records.delete(provisional.id);
              yield* persist([provisional.id]).pipe(Effect.catch(() => Effect.void));
              publish();
              yield* reports.remove(channel.runId);
            });
            yield* client
              .renamePane(pane.paneId, paneLabel(request.kind, name))
              .pipe(Effect.onError(() => rollback));
            const remote = yield* client
              .startAgent({
                kind: request.kind,
                model,
                paneId: pane.paneId,
                name: channel.agentName,
                harness,
              })
              .pipe(Effect.onError(() => rollback));
            yield* restorePreviousTabFocus(managed.snapshot, managed.project.tabId);
            const created: HerdrAgentView = {
              ...provisional,
              remoteStatus: remote.agentStatus,
              terminalId: remote.terminalId,
            };
            if (!matchesOwnedAgent(created, remote)) {
              yield* rollback;
              return yield* ownershipMismatch(
                "Herdr returned an agent outside the requested ownership tuple; the run was not adopted.",
              );
            }
            records.set(created.id, created);
            yield* persist();
            publish();
            const promptOutcome = yield* waitForInteractive(created, remote).pipe(
              Effect.andThen(client.prompt(created.agentName, taskPrompt(created.kind, task))),
              Effect.exit,
            );
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
                    "The managed agent started, but pi-herdr could not submit its task. Inspect the pane, retry with guidance, or stop it.",
                  updatedAt: promptTime,
                };
            records.set(updated.id, updated);
            yield* persist();
            publish();
            return { ...updated };
          }),
        ),
      ).pipe(
        Effect.catch((error) =>
          error._tag === "HerdrCommandError" &&
          (error.code === "agent_kind_mismatch" ||
            error.code === "agent_pane_busy" ||
            error.code === "timeout") &&
          remaining > 0
            ? Effect.yieldNow.pipe(Effect.andThen(attempt(remaining - 1)))
            : Effect.fail(error),
        ),
      );
    return attempt(TRANSIENT_START_RETRIES);
  };

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
        const remote = exactOwnedRemote(run, yield* client.snapshot);
        if (!remote)
          return yield* ownershipMismatch(
            "The managed agent ownership tuple changed; terminal output was not read.",
          );
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
                "Herdr runs with a final report cannot accept more guidance; start a new managed agent.",
            });
          const guidance = message.trim().slice(0, MAX_GUIDANCE_CHARS);
          if (!guidance)
            return yield* new InvalidHerdrRequestError({
              code: "message_required",
              message: "Herdr guidance must not be empty.",
            });
          const owned = exactOwnedRemote(run, yield* client.snapshot);
          if (!owned)
            return yield* ownershipMismatch(
              "The managed agent ownership tuple changed; guidance was not sent.",
            );
          const remote = yield* client.prompt(run.agentName, guidancePrompt(run.kind, guidance));
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
          const topologyPane = snapshot.panes.find((candidate) => candidate.paneId === run.paneId);
          const ownedPane = exactOwnedPane(run, snapshot);
          const remote = exactOwnedRemote(run, snapshot);
          const occupant = snapshot.agents.find((candidate) => candidate.paneId === run.paneId);
          if (topologyPane && (!ownedPane || (occupant !== undefined && !remote)))
            return yield* ownershipMismatch(
              "The managed agent ownership tuple changed; its pane was not closed.",
            );
          if (ownedPane) {
            yield* moveAnchorBeforeClose({
              closingRunId: run.id,
              pane: remote ?? ownedPane,
              snapshot,
            });
            yield* closePanePreservingFocus(run.paneId, run.tabId, snapshot);
          }
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
        if (!exactOwnedRemote(run, yield* client.snapshot))
          return yield* ownershipMismatch(
            "The managed agent ownership tuple changed; focus was not moved.",
          );
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
