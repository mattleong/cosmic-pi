import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { invokeHostCallback, synchronousRandomHex } from "pi-cosmic-core";
import { runWorkflowSandbox, type WorkflowSandboxOutcome } from "../boundary/codemode-sandbox.ts";
import { nodeAvailableParallelism } from "../boundary/node-builtins.ts";
import { saveWorkflowResult } from "../boundary/workflow-result-file.ts";
import type { WorkflowRunFiles } from "../boundary/workflow-run-files.ts";
import { SubagentService } from "../run/service.ts";
import type { WorkflowHost } from "./agent.ts";
import { makeWorkflowSlots, makeWorkflowWaitOrder } from "./admission-queue.ts";
import { requireStartArgs } from "./args.ts";
import { workflowViewStatus, type WorkflowViewStatus } from "./attention.ts";
import { makeWorkflowBudget } from "./budget.ts";
import { makeWorkflowDelivery, type WorkflowNotify } from "./delivery.ts";
import type { WorkflowNotFoundError, WorkflowRequestError } from "./errors.ts";
import { WorkflowJournal, type WorkflowInterruptedRun } from "./journal.ts";
import {
  emptyWorkflowUsage,
  isWorkflowRunFinished,
  workflowConcurrency,
  type WorkflowFailure,
  type WorkflowResult,
  type WorkflowRunView,
  type WorkflowStopOrigin,
} from "./model.ts";
import { makeWorkflowMembers, type WorkflowRunSetup } from "./members.ts";
import {
  fitWorkflowResult,
  interruptedWorkflowNotification,
  workflowNotification,
  workflowValueText,
} from "./notification.ts";
import { makeWorkflowRecovery } from "./recovery.ts";
import {
  notificationHandoff,
  type WorkflowRunHandoff,
  type WorkflowRunObserver,
} from "./run-observer.ts";
import { WORKFLOW_RUN_FILES_REFRESH_MS, type WorkflowRecordedRun } from "./run-record.ts";
import { makeWorkflowRunRecordWriter } from "./run-record-writer.ts";
import {
  makeWorkflowRuns,
  workflowNotFound,
  type WorkflowActivitySink,
  type WorkflowRunControl,
} from "./runs.ts";
import { workflowPlannedAgents, type WorkflowScriptError } from "./script.ts";
import { makeWorkflowSkip } from "./skip.ts";
import { makeWorkflowStatusRepeats, type WorkflowUnchangedStatus } from "./status-repeat.ts";
import { makeWorkflowSources, type WorkflowSourceRequest } from "./source.ts";
import {
  concludeWorkflow,
  finishWorkflowRun,
  retainWorkflowRuns,
  withWorkflowEvent,
  workflowServiceLog,
} from "./state.ts";
import { WorkflowStore, type WorkflowSourceError } from "./store.ts";

export interface WorkflowStartRequest {
  readonly source: WorkflowSourceRequest;
  readonly args: Schema.Json;
  readonly resumeFromRunId?: string | undefined;
  /** A hard ceiling on the output tokens the run's live agents produce. */
  readonly budget?: number | undefined;
}

export type WorkflowStartError = WorkflowScriptError | WorkflowSourceError | WorkflowRequestError;

/**
 * What status knows about a run: its view while this activation holds it, or else a read-only
 * summary from the run's files, such as for a run of an earlier Pi process of this session.
 */
export type WorkflowStatus =
  | WorkflowViewStatus
  | { readonly kind: "recorded"; readonly run: WorkflowRecordedRun };

/** What the main agent's own status call gets: the status, or a repeat's short answer. */
export type WorkflowToolStatus = WorkflowStatus | WorkflowUnchangedStatus;

export interface WorkflowServiceContract {
  /** Validates the source and starts the run in the background; returns its first view. */
  readonly start: (
    request: WorkflowStartRequest,
    host: WorkflowHost,
  ) => Effect.Effect<WorkflowRunView, WorkflowStartError>;
  /**
   * Stops the script and returns once its agents are stopped; finished runs are unchanged. A
   * stop the main agent requested sends no notification, since its result carries the state,
   * unless the call ends before returning it.
   */
  readonly stop: (
    runId: string,
    origin?: WorkflowStopOrigin,
  ) => Effect.Effect<WorkflowRunView, WorkflowNotFoundError>;
  readonly status: (runId: string) => Effect.Effect<WorkflowStatus, WorkflowNotFoundError>;
  /**
   * Status for the main agent's subagent_workflow call: a live run with nothing material changed
   * since that agent's previous call, within a minute, comes back unchanged instead, so polling
   * gets a short answer (see `status-repeat.ts`). Other callers use `status`.
   */
  readonly toolStatus: (runId: string) => Effect.Effect<WorkflowToolStatus, WorkflowNotFoundError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkflowRunView>>;
  /**
   * Resolves a queued or running workflow agent to null, by its subagent run id, or skips a planned
   * one no call has claimed, whose claiming call then resolves null without starting anything.
   */
  readonly skip: (agentRunId: string) => Effect.Effect<void, WorkflowNotFoundError>;
}

export interface WorkflowServiceOptions {
  /** Synchronous host bridge for Activity; stages every change and gets coalesced publishes. */
  readonly activity?: WorkflowActivitySink | undefined;
  readonly notify?: WorkflowNotify | undefined;
  /** Agents one run executes at once; defaults from the CPU count (`workflowConcurrency`). */
  readonly concurrency?: number | undefined;
  /**
   * The Pi session id run records are written under and must name to be resumed, announced or
   * described after a restart; without one, runs keep no record.
   */
  readonly sessionKey?: string | undefined;
  readonly observer?: WorkflowRunObserver | undefined;
}

/** A starting run's private files, or the warning it logs instead. */
interface SavedRunFiles {
  readonly files?: WorkflowRunFiles | undefined;
  readonly warning?: string | undefined;
}

const makeService = Effect.fnUntraced(function* (options: WorkflowServiceOptions) {
  const subagents = yield* SubagentService;
  const journal = yield* WorkflowJournal;
  const store = yield* WorkflowStore;
  const fs = yield* FileSystem.FileSystem;
  const concurrency = Math.max(
    1,
    options.concurrency ?? workflowConcurrency(nodeAvailableParallelism()),
  );
  // Finalizers run in reverse: Activity publishes and the closed flag first, then deliveries,
  // and last run fibers, whose own finalizers stop their agents while the subagent service is
  // still open. Keep this order.
  const fibers = yield* FiberMap.make<string>();
  const delivery = yield* makeWorkflowDelivery(options.notify);
  const runs = yield* makeWorkflowRuns(options.activity);
  const records = makeWorkflowRunRecordWriter({ store, runs, sessionKey: options.sessionKey });
  const recovery = makeWorkflowRecovery({ store, sessionKey: options.sessionKey });
  const sources = makeWorkflowSources({ store, journal, recovery, subagents, runs });
  const members = makeWorkflowMembers({ runs, subagents, journal, store, sources });
  const repeats = makeWorkflowStatusRepeats();
  // Clock-derived, so run ids stay unique across reloads that share a session's journals, and
  // random, so Pi processes that start in the same millisecond don't share run directories.
  const activatedAt = (yield* Clock.currentTimeMillis).toString(36);
  const namespace = `${activatedAt}${yield* Effect.sync(() => synchronousRandomHex(3))}`;
  let nextRunOrdinal = 1;

  /**
   * The result as the finished run's notification carries it; a value that doesn't fit is
   * clipped and saved in full.
   */
  const boundedResult = (value: Schema.Json, run: WorkflowRunView, save: boolean) =>
    Effect.gen(function* () {
      const text = workflowValueText(value);
      const fitted = fitWorkflowResult(run, text);
      if (!fitted.clipped) return fitted satisfies WorkflowResult;
      const path = save
        ? yield* saveWorkflowResult(text, Predicate.isString(value) ? "txt" : "json").pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          )
        : undefined;
      return { ...fitted, ...(path !== undefined && { path }) } satisfies WorkflowResult;
    });

  /** Tells the observer about a run; a failing host callback can't affect the run. */
  const observe = (tell: (observer: WorkflowRunObserver) => void) =>
    Effect.sync(() => {
      const observer = options.observer;
      if (observer) invokeHostCallback(() => tell(observer), undefined);
    });

  /** Closes a run once Pi accepted its report or notice, or when it needs none. */
  const closeRun = (id: string, handoff: WorkflowRunHandoff) =>
    observe((observer) => observer.closed(id, handoff)).pipe(
      Effect.andThen(journal.finish(id)),
      Effect.andThen(records.notified(id)),
    );

  /** Runs once the script's scope has closed, so every agent call has already settled. */
  const finish = (id: string, exit: Exit.Exit<WorkflowSandboxOutcome>) =>
    Effect.gen(function* () {
      // Ordered: the owner closes before the outcome is recorded, and the run record and
      // notification come last, once the view holds the final state.
      yield* subagents.closeOwner(id);
      runs.controls.remove(id);
      // Teardown interrupts runs and leaves them open, in memory and in their records, so the
      // next activation of this session reports them; a torn-down session gets no notification.
      const tornDown = yield* delivery.closed;
      const conclusion = concludeWorkflow(exit);
      const at = yield* Clock.currentTimeMillis;
      const current = yield* runs.find(id);
      // The result gets the room the notification's other sections leave.
      const result =
        conclusion.value === undefined || !current
          ? undefined
          : yield* boundedResult(
              conclusion.value,
              finishWorkflowRun(current, conclusion, undefined, at),
              !tornDown,
            );
      const finished = yield* runs.update(id, (run) =>
        finishWorkflowRun(run, conclusion, result, at),
      );
      // Once the view is final, a later status call can't note the run as live again.
      repeats.forget(id);
      yield* runs.mutate(retainWorkflowRuns);
      if (finished) yield* records.end(finished, tornDown);
      if (tornDown) return;
      // A teardown before Pi accepts the report then says how the run ended.
      if (finished && isWorkflowRunFinished(finished.state))
        yield* journal.noteEnded(id, finished.state);
      const notification = finished && workflowNotification(finished);
      yield* delivery.report(notification, closeRun(id, notificationHandoff(notification)));
    });

  /**
   * Keeps a live run's directory recent, every minute, for other Pi processes' pruning and as the
   * heartbeat that tells them the run's process still runs it. Timers don't advance while the
   * machine sleeps, so a short period marks the directory again soon after it wakes.
   */
  const keepRunFilesRecent = (setup: WorkflowRunSetup) =>
    setup.files === undefined
      ? Effect.void
      : store
          .touchRunFiles(setup.files)
          .pipe(
            Effect.delay(WORKFLOW_RUN_FILES_REFRESH_MS),
            Effect.forever,
            Effect.forkScoped,
            Effect.asVoid,
          );

  /**
   * The script's outcome, unless the host failed the run, such as for a call past its agent
   * limit, and nobody asked it to stop: then the run fails with the host's failure whatever the
   * aborted script returned, so a script that catches every error still ends there.
   */
  const hostOutcome = (
    control: WorkflowRunControl,
    outcome: WorkflowSandboxOutcome,
  ): Effect.Effect<WorkflowSandboxOutcome> =>
    Effect.gen(function* () {
      if ((yield* Deferred.isDone(control.stop)) || !(yield* Deferred.isDone(control.failed)))
        return outcome;
      const failure = yield* Deferred.await(control.failed);
      return { _tag: "Failed", kind: "script", failure, output: outcome.output };
    });

  /** The run's record is written before its script starts, so a crash after that is announced. */
  const runFiber = (setup: WorkflowRunSetup, created: WorkflowRunView) =>
    Effect.scoped(
      records.create(created, setup.files).pipe(
        Effect.andThen(keepRunFilesRecent(setup)),
        Effect.andThen(Effect.forkScoped(setup.budget.watch)),
        Effect.andThen(
          runWorkflowSandbox(
            setup.script.body,
            setup.args,
            members(setup),
            Effect.raceFirst(
              Deferred.await(setup.control.stop),
              Deferred.await(setup.control.failed).pipe(Effect.asVoid),
            ),
            setup.budget.total,
          ),
        ),
        Effect.flatMap((outcome) => hostOutcome(setup.control, outcome)),
      ),
    ).pipe(Effect.onExit((exit) => finish(setup.id, exit)));

  /**
   * Saves the run's script in its private directory; a failure becomes a warning in the run's
   * log instead of failing the start.
   */
  const saveRunFiles = (id: string, source: string) =>
    runs.list.pipe(
      Effect.map(
        (views) =>
          new Set(views.filter((run) => !isWorkflowRunFinished(run.state)).map((run) => run.id)),
      ),
      Effect.flatMap((live) => store.createRunFiles(id, source, live)),
      Effect.match({
        onSuccess: (files): SavedRunFiles => ({ files }),
        onFailure: (error): SavedRunFiles => ({
          warning: `Couldn't save an editable copy of the script: ${error.message}`,
        }),
      }),
    );

  const start: WorkflowServiceContract["start"] = (request, host) =>
    Effect.gen(function* () {
      const { script, source } = yield* sources.load(request.source);
      yield* requireStartArgs(script.args, script.meta.name, request.args);
      const replay =
        request.resumeFromRunId === undefined
          ? undefined
          : yield* sources.resumeReplay(request.resumeFromRunId);
      const slots = makeWorkflowSlots(concurrency);
      const startedAt = yield* Clock.currentTimeMillis;
      const ordinal = nextRunOrdinal++;
      const id = `wf-${namespace}-${ordinal}`;
      const budget = makeWorkflowBudget(request.budget, {
        subagents,
        warn: (message) => runs.recordEvent(id, workflowServiceLog("warning", message)),
        show: (current) =>
          runs.update(id, (run) => ({ ...run, budget: current() })).pipe(Effect.asVoid),
      });
      const planned = yield* sources.reservePlanned(
        (script.meta.phases ?? []).flatMap((phase) => workflowPlannedAgents(phase)),
      );
      const saved = yield* saveRunFiles(id, script.source);
      // Registration is atomic: an open owner always has a run fiber that will close it.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* journal.open(id, script.meta.name, { source, scriptPath: saved.files?.script });
          yield* subagents.openOwner(id);
          const created: WorkflowRunView = {
            id,
            name: script.meta.name,
            description: script.meta.description,
            source,
            sha256: script.sha256,
            phases: script.meta.phases ?? [],
            state: "running",
            startedAt,
            agents: [],
            planned,
            reused: 0,
            logs: [],
            usage: emptyWorkflowUsage(),
            args: request.args,
            ...(saved.files && { scriptPath: saved.files.script }),
            ...(request.resumeFromRunId !== undefined && { resumedFrom: request.resumeFromRunId }),
            ...(request.budget !== undefined && {
              budget: { total: request.budget, spent: 0, refused: 0 },
            }),
          };
          const view =
            saved.warning === undefined
              ? created
              : withWorkflowEvent(created, workflowServiceLog("warning", saved.warning), startedAt);
          yield* runs.mutate((views) => retainWorkflowRuns([...views, view]));
          const control: WorkflowRunControl = {
            calls: 0,
            skips: new Map(),
            stop: Deferred.makeUnsafe<void>(),
            failed: Deferred.makeUnsafe<WorkflowFailure>(),
            journalLock: Semaphore.makeUnsafe(1),
            journal: { written: false, warned: false, results: 0 },
          };
          runs.controls.add(id, control);
          yield* observe((observer) => observer.opened(id));
          yield* FiberMap.run(
            fibers,
            id,
            runFiber(
              {
                id,
                script,
                args: request.args,
                host,
                replay,
                slots,
                order: makeWorkflowWaitOrder(),
                budget,
                control,
                files: saved.files,
              },
              view,
            ),
          );
          return view;
        }),
      );
    });

  /** Waits until the run's fiber, and so every agent, has ended. */
  const awaitStopped = (id: string) =>
    Effect.gen(function* () {
      const fiber = yield* FiberMap.get(fibers, id);
      // The aborted script's scope closes, and so every agent stops, before the fiber ends.
      if (Option.isSome(fiber)) yield* Fiber.await(fiber.value);
      return yield* runs.require(id);
    });

  /**
   * The main agent's stop call ended before returning the final state, so the run reports like
   * any other stop: the notification carries the state and worktrees without starting a turn.
   */
  const releaseToolStop = (id: string) =>
    Effect.gen(function* () {
      const released = yield* runs.modify(id, (run) =>
        run.stoppedBy === "tool"
          ? ([run, { ...run, stoppedBy: undefined }] as const)
          : ([undefined, run] as const),
      );
      if (!released || !isWorkflowRunFinished(released.state) || (yield* delivery.closed)) return;
      // The run settled first, and its finish sent nothing for the tool's stop.
      const notification = workflowNotification({ ...released, stoppedBy: undefined });
      if (notification) yield* delivery.send(notification);
    });

  const stop: WorkflowServiceContract["stop"] = (id, origin = "user") =>
    // Marking the run and signalling its script happen together; only the wait is interruptible.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const current = yield* runs.require(id);
        if (isWorkflowRunFinished(current.state)) return current;
        // A teardown before the run settles then reports it without a restart hint.
        yield* journal.noteStop(id);
        yield* runs.update(id, (run) =>
          run.state === "running" ? { ...run, state: "stopping", stoppedBy: origin } : run,
        );
        const control = runs.controls.get(id);
        if (control) yield* Deferred.succeed(control.stop, undefined);
        return yield* restore(
          records.noteStop(id, origin).pipe(Effect.andThen(awaitStopped(id))),
        ).pipe(Effect.onInterrupt(() => (origin === "tool" ? releaseToolStop(id) : Effect.void)));
      }),
    );

  const status: WorkflowServiceContract["status"] = (id) =>
    Effect.gen(function* () {
      const view = yield* runs.find(id);
      if (view) return yield* workflowViewStatus(subagents, view);
      const recorded = yield* recovery.recorded(id);
      if (recorded) return { kind: "recorded", run: recorded } satisfies WorkflowStatus;
      return yield* workflowNotFound(id);
    });

  const toolStatus: WorkflowServiceContract["toolStatus"] = (id) =>
    Effect.gen(function* () {
      const found = yield* status(id);
      if (found.kind !== "view") return found;
      const now = yield* Clock.currentTimeMillis;
      const sinceMs = yield* Effect.sync(() => repeats.note(found, now));
      if (sinceMs === undefined) return found;
      return { kind: "unchanged", run: found.run, sinceMs } satisfies WorkflowUnchangedStatus;
    });

  const announce = (interrupted: WorkflowInterruptedRun) => {
    const notice = interruptedWorkflowNotification(interrupted);
    return observe((observer) => observer.opened(interrupted.runId)).pipe(
      Effect.andThen(
        delivery.report(notice, closeRun(interrupted.runId, notificationHandoff(notice))),
      ),
    );
  };

  /** A run memory holds is closed instead when another Pi process of the session announced it. */
  const announceRemembered = (interrupted: WorkflowInterruptedRun) =>
    recovery
      .noticeAccepted(interrupted.runId)
      .pipe(
        Effect.flatMap((accepted) =>
          accepted ? closeRun(interrupted.runId, "next-turn") : announce(interrupted),
        ),
      );

  // Runs this session's earlier activation left running were torn down without a word; tell
  // the main agent once, so it doesn't keep waiting for their results. Each stays open until its
  // notice is accepted. They are read before this activation opens runs of its own.
  const remembered = yield* journal.interruptedRuns;
  // Then runs an earlier Pi process of this session left unfinished are found in their files.
  // Memory reports the runs it holds, and the files are read off the start path.
  yield* Effect.forEach(remembered, announceRemembered, { discard: true }).pipe(
    Effect.andThen(recovery.interrupted(journal.has)),
    Effect.flatMap((owed) => Effect.forEach(owed, announce, { discard: true })),
    Effect.forkScoped,
  );

  return WorkflowService.of({
    start,
    stop,
    status,
    toolStatus,
    list: runs.list,
    skip: makeWorkflowSkip(runs),
  });
});

/** Session-scoped dynamic workflow runs. Depends on SubagentService, so it closes first. */
export class WorkflowService extends Context.Service<WorkflowService, WorkflowServiceContract>()(
  "pi-subagents/workflow/service/WorkflowService",
) {
  static readonly layer = (
    options: WorkflowServiceOptions = {},
  ): Layer.Layer<
    WorkflowService,
    never,
    SubagentService | WorkflowJournal | WorkflowStore | FileSystem.FileSystem
  > => Layer.effect(this, makeService(options));
}
