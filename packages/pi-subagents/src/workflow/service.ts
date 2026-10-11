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
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { invokeHostCallback, synchronousRandomHex } from "pi-cosmic-core";
import { runWorkflowSandbox, type WorkflowSandboxOutcome } from "../boundary/codemode-sandbox.ts";
import { nodeAvailableParallelism } from "../boundary/node-builtins.ts";
import { saveWorkflowResult } from "../boundary/workflow-result-file.ts";
import { SubagentService } from "../run/service.ts";
import type { WorkflowHost } from "./agent.ts";
import { makeWorkflowSlots } from "./admission-queue.ts";
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
  readonly budget?: number | undefined;
}

export type WorkflowStartError = WorkflowScriptError | WorkflowSourceError | WorkflowRequestError;

export type WorkflowStatus =
  | WorkflowViewStatus
  | { readonly kind: "recorded"; readonly run: WorkflowRecordedRun };

export type WorkflowToolStatus = WorkflowStatus | WorkflowUnchangedStatus;

export interface WorkflowServiceContract {
  readonly start: (
    request: WorkflowStartRequest,
    host: WorkflowHost,
  ) => Effect.Effect<WorkflowRunView, WorkflowStartError>;
  readonly stop: (
    runId: string,
    origin?: WorkflowStopOrigin,
  ) => Effect.Effect<WorkflowRunView, WorkflowNotFoundError>;
  readonly status: (runId: string) => Effect.Effect<WorkflowStatus, WorkflowNotFoundError>;
  readonly toolStatus: (runId: string) => Effect.Effect<WorkflowToolStatus, WorkflowNotFoundError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkflowRunView>>;
  readonly skip: (agentRunId: string) => Effect.Effect<void, WorkflowNotFoundError>;
}

interface WorkflowServiceOptions {
  readonly activity?: WorkflowActivitySink | undefined;
  readonly notify?: WorkflowNotify | undefined;
  readonly concurrency?: number | undefined;
  readonly sessionKey?: string | undefined;
  readonly observer?: WorkflowRunObserver | undefined;
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
  const fibers = yield* FiberMap.make<string>();
  const delivery = yield* makeWorkflowDelivery(options.notify);
  const runs = yield* makeWorkflowRuns(options.activity);
  const records = yield* makeWorkflowRunRecordWriter({
    store,
    runs,
    sessionKey: options.sessionKey,
  });
  const recovery = makeWorkflowRecovery({ store, sessionKey: options.sessionKey });
  const sources = makeWorkflowSources({ store, journal, recovery, subagents, runs });
  const members = makeWorkflowMembers({ runs, subagents, journal, store, sources });
  const repeats = makeWorkflowStatusRepeats();
  const activatedAt = (yield* Clock.currentTimeMillis).toString(36);
  const namespace = `${activatedAt}${yield* Effect.sync(() => synchronousRandomHex(3))}`;
  let nextRunOrdinal = 1;

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

  const observe = (tell: (observer: WorkflowRunObserver) => void) =>
    Effect.sync(() => {
      const observer = options.observer;
      if (observer) invokeHostCallback(() => tell(observer), undefined);
    });

  const closeRun = (id: string, handoff: WorkflowRunHandoff) =>
    observe((observer) => observer.closed(id, handoff)).pipe(
      Effect.andThen(journal.finish(id)),
      Effect.andThen(records.notified(id)),
    );

  const finish = (id: string, exit: Exit.Exit<WorkflowSandboxOutcome>) =>
    Effect.gen(function* () {
      yield* subagents.closeOwner(id);
      runs.controls.delete(id);
      const tornDown = yield* delivery.closed;
      const conclusion = concludeWorkflow(exit);
      const at = yield* Clock.currentTimeMillis;
      const current = yield* runs.find(id);
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
      repeats.forget(id);
      yield* runs.mutate(retainWorkflowRuns);
      if (finished) yield* records.end(finished, tornDown);
      if (tornDown) return;
      if (finished && isWorkflowRunFinished(finished.state))
        yield* journal.noteEnded(id, finished.state);
      const notification = finished && workflowNotification(finished);
      yield* delivery.report(notification, closeRun(id, notificationHandoff(notification)));
    });

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

  const saveRunFiles = (id: string, source: string) =>
    runs.list.pipe(
      Effect.flatMap((views) =>
        store.createRunFiles(
          id,
          source,
          new Set(views.flatMap((run) => (isWorkflowRunFinished(run.state) ? [] : [run.id]))),
        ),
      ),
      Effect.mapError((error) =>
        workflowServiceLog(
          "warning",
          `Couldn't save an editable copy of the script: ${error.message}`,
        ),
      ),
      Effect.result,
    );

  const start = Effect.fn("WorkflowService.start")(function* (
    request: WorkflowStartRequest,
    host: WorkflowHost,
  ) {
    const { script, source } = yield* sources.load(request.source);
    yield* requireStartArgs(script.args, script.meta.name, request.args);
    const replay =
      request.resumeFromRunId === undefined
        ? undefined
        : yield* sources.resumeReplay(request.resumeFromRunId);
    const slots = makeWorkflowSlots(concurrency);
    const startedAt = yield* Clock.currentTimeMillis;
    const id = `wf-${namespace}-${nextRunOrdinal++}`;
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
    const files = Result.getOrUndefined(saved);
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* journal.open(id, script.meta.name, { source, scriptPath: files?.script });
        yield* subagents.openOwner(id);
        const created: WorkflowRunView = {
          id,
          name: script.meta.name,
          description: script.meta.description,
          source,
          phases: script.meta.phases ?? [],
          state: "running",
          startedAt,
          agents: [],
          planned,
          reused: 0,
          logs: [],
          usage: emptyWorkflowUsage(),
          args: request.args,
          ...(files && { scriptPath: files.script }),
          ...(request.resumeFromRunId !== undefined && { resumedFrom: request.resumeFromRunId }),
          ...(request.budget !== undefined && {
            budget: { total: request.budget, spent: 0, refused: 0 },
          }),
        };
        const view = Result.isFailure(saved)
          ? withWorkflowEvent(created, saved.failure, startedAt)
          : created;
        yield* runs.mutate((views) => retainWorkflowRuns([...views, view]));
        const control: WorkflowRunControl = {
          calls: 0,
          skips: new Map(),
          stop: yield* Deferred.make<void>(),
          failed: yield* Deferred.make<WorkflowFailure>(),
          journalLock: yield* Semaphore.make(1),
          journal: { written: false, warned: false, results: 0 },
        };
        runs.controls.set(id, control);
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
              budget,
              control,
              files,
            },
            view,
          ),
        );
        return view;
      }),
    );
  });

  const awaitStopped = (id: string) =>
    Effect.gen(function* () {
      const fiber = yield* FiberMap.get(fibers, id);
      if (Option.isSome(fiber)) yield* Fiber.await(fiber.value);
      return yield* runs.require(id);
    });

  const releaseToolStop = (id: string) =>
    Effect.gen(function* () {
      const released = yield* runs.modify(id, (run) =>
        run.stoppedBy === "tool"
          ? ([run, { ...run, stoppedBy: undefined }] as const)
          : ([undefined, run] as const),
      );
      if (!released || !isWorkflowRunFinished(released.state) || (yield* delivery.closed)) return;
      const notification = workflowNotification({ ...released, stoppedBy: undefined });
      if (notification) yield* delivery.send(notification);
    });

  const stop: WorkflowServiceContract["stop"] = (id, origin = "user") =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const current = yield* runs.require(id);
        if (isWorkflowRunFinished(current.state)) return current;
        yield* journal.noteStop(id);
        const claim = yield* runs.modify(id, (run) => {
          if (run.state === "running")
            return ["starts", { ...run, state: "stopping", stoppedBy: origin }] as const;
          const released = run.state === "stopping" && run.stoppedBy === undefined;
          return [released ? "records" : "joins", run] as const;
        });
        const control = runs.controls.get(id);
        if (control) yield* Deferred.succeed(control.stop, undefined);
        if (claim === "starts" || claim === "records") yield* records.noteStop(id, origin);
        const stopped = restore(awaitStopped(id));
        return yield* claim === "starts" && origin === "tool"
          ? stopped.pipe(Effect.onInterrupt(() => releaseToolStop(id)))
          : stopped;
      }),
    );

  const status = Effect.fn("WorkflowService.status")(function* (id: string) {
    const view = yield* runs.find(id);
    if (view) return yield* workflowViewStatus(subagents, view);
    const recorded = yield* recovery.recorded(id);
    if (recorded) return { kind: "recorded", run: recorded } satisfies WorkflowStatus;
    return yield* workflowNotFound(id);
  });

  const toolStatus = Effect.fn("WorkflowService.toolStatus")(function* (id: string) {
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

  const announceRemembered = (interrupted: WorkflowInterruptedRun) =>
    recovery
      .noticeAccepted(interrupted.runId)
      .pipe(
        Effect.flatMap((accepted) =>
          accepted ? closeRun(interrupted.runId, "next-turn") : announce(interrupted),
        ),
      );

  const remembered = yield* journal.interruptedRuns;
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
