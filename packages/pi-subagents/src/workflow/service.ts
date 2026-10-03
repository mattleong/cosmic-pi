import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  runWorkflowSandbox,
  type WorkflowSandboxHost,
  type WorkflowSandboxOutcome,
} from "../boundary/codemode-sandbox.ts";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";
import { nodeAvailableParallelism } from "../boundary/node-builtins.ts";
import { saveWorkflowResult } from "../boundary/workflow-result-file.ts";
import { SubagentService } from "../run/service.ts";
import { makeWorkflowAgentCall, type WorkflowHost } from "./agent.ts";
import { WorkflowJournal, type WorkflowReplay } from "./journal.ts";
import {
  isWorkflowRunFinished,
  WORKFLOW_AGENT_LIMIT,
  WORKFLOW_ARGS_MAX_CHARS,
  workflowConcurrency,
  type WorkflowResult,
  type WorkflowRunView,
  type WorkflowSource,
  type WorkflowStopOrigin,
} from "./model.ts";
import {
  fitWorkflowResult,
  interruptedWorkflowNotification,
  workflowNotification,
  workflowValueText,
} from "./notification.ts";
import { parseWorkflowScript, type WorkflowScript, type WorkflowScriptError } from "./script.ts";
import {
  concludeWorkflow,
  decodeWorkflowEvent,
  finishWorkflowRun,
  retainWorkflowRuns,
  withAgent,
  withAgentChange,
  withNestedPhases,
  withReusedResult,
  withWorkflowEvent,
  type WorkflowEvent,
} from "./state.ts";
import { WorkflowStore, type WorkflowSourceError } from "./store.ts";

export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { message: Schema.String },
) {}

export class WorkflowRequestError extends Schema.TaggedError<WorkflowRequestError>()(
  "WorkflowRequestError",
  { code: Schema.String, message: Schema.String },
) {}

export type WorkflowSourceRequest =
  | { readonly kind: "inline"; readonly script: string }
  | { readonly kind: "saved"; readonly name: string }
  | { readonly kind: "file"; readonly path: string };

export interface WorkflowStartRequest {
  readonly source: WorkflowSourceRequest;
  readonly args: Schema.Json;
  readonly resumeFromRunId?: string | undefined;
}

export type WorkflowStartError = WorkflowScriptError | WorkflowSourceError | WorkflowRequestError;

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
  readonly status: (runId: string) => Effect.Effect<WorkflowRunView, WorkflowNotFoundError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkflowRunView>>;
  /** Resolves a queued or running workflow agent to null, by its subagent run id. */
  readonly skip: (agentRunId: string) => Effect.Effect<void, WorkflowNotFoundError>;
  readonly changes: Stream.Stream<ReadonlyArray<WorkflowRunView>>;
}

export interface WorkflowServiceOptions {
  /** Synchronous host bridge for Activity; receives every change. */
  readonly publish?: ((runs: ReadonlyArray<WorkflowRunView>) => void) | undefined;
  readonly notify?:
    | ((notification: SubagentWorkflowNotification) => SubagentNotificationDelivery | undefined)
    | undefined;
  /** Agents one run executes at once; defaults from the CPU count. */
  readonly concurrency?: number | undefined;
}

const DELIVERY_RETRY_INITIAL_MS = 100;
const DELIVERY_RETRY_MAX_MS = 30_000;

const NestedReferenceSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ scriptPath: Schema.String }),
]);
const decodeNestedReference = Schema.decodeUnknownOption(NestedReferenceSchema);
const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Json));

/** Per-run control state the service alone mutates. */
interface RunControl {
  calls: number;
  readonly skips: Map<string, Deferred.Deferred<void>>;
  /** Completes when the run is asked to stop; the script aborts and keeps its output. */
  readonly stop: Deferred.Deferred<void>;
}

interface RunSetup {
  readonly id: string;
  readonly script: WorkflowScript;
  readonly args: Schema.Json;
  readonly host: WorkflowHost;
  readonly replay: WorkflowReplay | undefined;
  readonly permits: Semaphore.Semaphore;
  readonly control: RunControl;
}

const requestError = (code: string, message: string) => new WorkflowRequestError({ code, message });

const makeService = Effect.fnUntraced(function* (options: WorkflowServiceOptions) {
  const subagents = yield* SubagentService;
  const journal = yield* WorkflowJournal;
  const store = yield* WorkflowStore;
  const fs = yield* FileSystem.FileSystem;
  const concurrency = Math.max(
    1,
    options.concurrency ?? workflowConcurrency(nodeAvailableParallelism()),
  );
  // Finalizers run in reverse: the closed flag first, then deliveries, then run fibers, whose
  // own finalizers stop their agents while the subagent service is still open.
  const fibers = yield* FiberMap.make<string>();
  const deliveries = yield* FiberSet.make();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );
  const state = yield* SubscriptionRef.make<ReadonlyArray<WorkflowRunView>>([]);
  const controls = new Map<string, RunControl>();
  // Clock-derived, so run ids stay unique across reloads that share a session's journals.
  const namespace = (yield* Clock.currentTimeMillis).toString(36);
  let nextRunOrdinal = 1;

  const publishLatest = Effect.suspend(() => {
    const publish = options.publish;
    if (closed || !publish) return Effect.void;
    const runs = SubscriptionRef.getUnsafe(state);
    return Effect.try(() => publish(runs)).pipe(Effect.ignore);
  });

  const mutate = (
    change: (runs: ReadonlyArray<WorkflowRunView>) => ReadonlyArray<WorkflowRunView>,
  ) => SubscriptionRef.update(state, change).pipe(Effect.andThen(publishLatest));

  /**
   * Atomically applies `change` to one run, which also returns a value derived from the run as
   * it was; undefined once the run is evicted.
   */
  const modifyRun = <A>(
    id: string,
    change: (run: WorkflowRunView) => readonly [A, WorkflowRunView],
  ): Effect.Effect<A | undefined> =>
    SubscriptionRef.modify(
      state,
      (runs): readonly [A | undefined, ReadonlyArray<WorkflowRunView>] => {
        const index = runs.findIndex((run) => run.id === id);
        const current = runs[index];
        if (!current) return [undefined, runs];
        const [value, updated] = change(current);
        return [value, runs.with(index, updated)];
      },
    ).pipe(Effect.tap(() => publishLatest));

  /** Applies `change` to one run and returns the result, or undefined once evicted. */
  const updateRun = (id: string, change: (run: WorkflowRunView) => WorkflowRunView) =>
    modifyRun(id, (run) => {
      const updated = change(run);
      return [updated, updated] as const;
    });

  const requireRun = (id: string) =>
    SubscriptionRef.get(state).pipe(
      Effect.flatMap((runs) => {
        const run = runs.find((candidate) => candidate.id === id);
        return run
          ? Effect.succeed(run)
          : Effect.fail(
              new WorkflowNotFoundError({
                message: `No workflow run ${id} in this session. Runs started before a reload or another session aren't listed.`,
              }),
            );
      }),
    );

  const recordEvent = (id: string, event: WorkflowEvent) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((at) => updateRun(id, (run) => withWorkflowEvent(run, event, at))),
      Effect.asVoid,
    );

  const loadSource = (
    source: WorkflowSourceRequest,
  ): Effect.Effect<
    { readonly script: WorkflowScript; readonly source: WorkflowSource },
    WorkflowScriptError | WorkflowSourceError
  > => {
    switch (source.kind) {
      case "inline":
        return parseWorkflowScript(source.script).pipe(
          Effect.map((script) => ({ script, source: { kind: "inline" } as const })),
        );
      case "saved":
        return store.load(source.name).pipe(
          Effect.map((loaded) => ({
            script: loaded.script,
            source: {
              kind: "saved" as const,
              name: loaded.name,
              scope: loaded.scope ?? "user",
              path: loaded.path,
            },
          })),
        );
      case "file":
        return store.loadPath(source.path).pipe(
          Effect.map((loaded) => ({
            script: loaded.script,
            source: { kind: "file" as const, path: loaded.path },
          })),
        );
    }
  };

  const resumeReplay = (runId: string) =>
    Effect.gen(function* () {
      const earlier = (yield* SubscriptionRef.get(state)).find((run) => run.id === runId);
      if (earlier && !isWorkflowRunFinished(earlier.state))
        return yield* requestError(
          "resume_running",
          `Workflow ${runId} is still running. Stop it or wait for its result before resuming it.`,
        );
      const replay = yield* journal.replay(runId);
      if (!replay)
        return yield* requestError(
          "resume_unknown",
          `No workflow run ${runId} is known to this Pi session. Resume works for the session's recent runs (up to 32, while their results fit in memory) until Pi restarts.`,
        );
      return replay;
    });

  const loadNested = (id: string, reference: Schema.Json) =>
    Effect.gen(function* () {
      const decoded = decodeNestedReference(reference);
      if (Option.isNone(decoded))
        return yield* Effect.fail({
          message: "workflow() expects a saved workflow name or { scriptPath }.",
        });
      const loaded = yield* Predicate.isString(decoded.value)
        ? store.load(decoded.value)
        : store.loadPath(decoded.value.scriptPath);
      yield* updateRun(id, (run) => withNestedPhases(run, loaded.script, loaded.name));
      return { name: loaded.name, body: loaded.script.body };
    });

  const members = (setup: RunSetup): WorkflowSandboxHost<never> => ({
    agent: makeWorkflowAgentCall(
      {
        workflowId: setup.id,
        workflowName: setup.script.meta.name,
        host: setup.host,
        replay: setup.replay,
        permits: setup.permits,
        nextCall: Effect.sync(() =>
          setup.control.calls >= WORKFLOW_AGENT_LIMIT ? undefined : ++setup.control.calls,
        ),
        queue: (agent, skip) =>
          Effect.sync(() => void setup.control.skips.set(agent.runId, skip)).pipe(
            Effect.andThen(updateRun(setup.id, (run) => withAgent(run, agent))),
            Effect.asVoid,
          ),
        update: (runId, change) =>
          updateRun(setup.id, (run) => withAgentChange(run, runId, change)).pipe(Effect.asVoid),
        forget: (runId) => Effect.sync(() => void setup.control.skips.delete(runId)),
        log: (level, message) => recordEvent(setup.id, { type: "log", level, message }),
        count: (outputTokens) =>
          updateRun(setup.id, (run) => ({
            ...run,
            outputTokens: run.outputTokens + outputTokens,
          })).pipe(Effect.asVoid),
        reuse: (entry, phase) =>
          updateRun(setup.id, (run) => withReusedResult(run, entry, phase)).pipe(Effect.asVoid),
      },
      { subagents, journal },
    ),
    event: (event) =>
      Option.match(decodeWorkflowEvent(event), {
        onNone: () => Effect.void,
        onSome: (decoded) => recordEvent(setup.id, decoded),
      }),
    load: (reference) => loadNested(setup.id, reference),
  });

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

  /**
   * Retries with backoff until the host accepts the notification, and reports whether it did.
   * Without a host nothing can accept it, so it counts as delivered; a closed session drops it.
   */
  const deliver = (notification: SubagentWorkflowNotification) => {
    const attempt = (delay: number): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const notify = options.notify;
        if (closed) return Effect.succeed(false);
        if (!notify) return Effect.succeed(true);
        return Effect.try(() => notify(notification)?.actionAccepted === true).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.succeed(true)
              : Effect.sleep(delay).pipe(
                  Effect.andThen(attempt(Math.min(delay * 2, DELIVERY_RETRY_MAX_MS))),
                ),
          ),
        );
      });
    return attempt(DELIVERY_RETRY_INITIAL_MS);
  };

  /**
   * Delivers a run's report in the background and closes its journal once the host accepts it,
   * so a report a teardown drops is still announced by the next activation.
   */
  const report = (runId: string, notification: SubagentWorkflowNotification | undefined) =>
    notification
      ? FiberSet.run(
          deliveries,
          deliver(notification).pipe(
            Effect.flatMap((accepted) => (accepted ? journal.finish(runId) : Effect.void)),
          ),
        ).pipe(Effect.asVoid)
      : journal.finish(runId);

  /** Runs once the script's scope has closed, so every agent call has already settled. */
  const finish = (id: string, exit: Exit.Exit<WorkflowSandboxOutcome>) =>
    Effect.gen(function* () {
      yield* subagents.closeOwner(id);
      controls.delete(id);
      // Teardown interrupts runs and leaves their journals open, so the next activation of this
      // session reports them; a torn-down session gets no notification.
      const tornDown = closed;
      const conclusion = concludeWorkflow(exit);
      const at = yield* Clock.currentTimeMillis;
      const current = (yield* SubscriptionRef.get(state)).find((run) => run.id === id);
      // The result gets the room the notification's other sections leave.
      const result =
        conclusion.value === undefined || !current
          ? undefined
          : yield* boundedResult(
              conclusion.value,
              finishWorkflowRun(current, conclusion, undefined, at),
              !tornDown,
            );
      const finished = yield* updateRun(id, (run) =>
        finishWorkflowRun(run, conclusion, result, at),
      );
      yield* mutate(retainWorkflowRuns);
      if (!tornDown) yield* report(id, finished && workflowNotification(finished));
    });

  const runFiber = (setup: RunSetup) =>
    Effect.scoped(
      runWorkflowSandbox(
        setup.script.body,
        setup.args,
        members(setup),
        Deferred.await(setup.control.stop),
      ),
    ).pipe(Effect.onExit((exit) => finish(setup.id, exit)));

  const start: WorkflowServiceContract["start"] = (request, host) =>
    Effect.gen(function* () {
      const { script, source } = yield* loadSource(request.source);
      const argsText = Option.getOrElse(encodeJson(request.args), () => "");
      if (argsText.length > WORKFLOW_ARGS_MAX_CHARS)
        return yield* requestError(
          "args_too_large",
          `Workflow args are limited to ${WORKFLOW_ARGS_MAX_CHARS} characters of JSON; pass file paths for larger inputs.`,
        );
      const replay =
        request.resumeFromRunId === undefined
          ? undefined
          : yield* resumeReplay(request.resumeFromRunId);
      const permits = yield* Semaphore.make(concurrency);
      const startedAt = yield* Clock.currentTimeMillis;
      // Registration is atomic: an open owner always has a run fiber that will close it.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const id = `wf-${namespace}-${nextRunOrdinal++}`;
          yield* journal.open(id, script.meta.name);
          yield* subagents.openOwner(id);
          const view: WorkflowRunView = {
            id,
            name: script.meta.name,
            description: script.meta.description,
            source,
            sha256: script.sha256,
            phases: script.meta.phases ?? [],
            state: "running",
            startedAt,
            agents: [],
            reused: 0,
            logs: [],
            outputTokens: 0,
            args: request.args,
            ...(request.resumeFromRunId !== undefined && { resumedFrom: request.resumeFromRunId }),
          };
          yield* mutate((runs) => retainWorkflowRuns([...runs, view]));
          const control: RunControl = {
            calls: 0,
            skips: new Map(),
            stop: Deferred.makeUnsafe<void>(),
          };
          controls.set(id, control);
          yield* FiberMap.run(
            fibers,
            id,
            runFiber({ id, script, args: request.args, host, replay, permits, control }),
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
      return yield* requireRun(id);
    });

  /**
   * The main agent's stop call ended before returning the final state, so the run reports like
   * any other stop: the notification carries the state and worktrees without starting a turn.
   */
  const releaseToolStop = (id: string) =>
    Effect.gen(function* () {
      const released = yield* modifyRun(id, (run) =>
        run.stoppedBy === "tool"
          ? ([run, { ...run, stoppedBy: undefined }] as const)
          : ([undefined, run] as const),
      );
      if (!released || !isWorkflowRunFinished(released.state) || closed) return;
      // The run settled first, and its finish sent nothing for the tool's stop.
      const notification = workflowNotification({ ...released, stoppedBy: undefined });
      if (notification) yield* FiberSet.run(deliveries, deliver(notification));
    });

  const stop: WorkflowServiceContract["stop"] = (id, origin = "user") =>
    // Marking the run and signalling its script happen together; only the wait is interruptible.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const current = yield* requireRun(id);
        if (isWorkflowRunFinished(current.state)) return current;
        // A teardown before the run settles then reports it without a restart hint.
        yield* journal.noteStop(id);
        yield* updateRun(id, (run) =>
          run.state === "running" ? { ...run, state: "stopping", stoppedBy: origin } : run,
        );
        const control = controls.get(id);
        if (control) yield* Deferred.succeed(control.stop, undefined);
        return yield* restore(awaitStopped(id)).pipe(
          Effect.onInterrupt(() => (origin === "tool" ? releaseToolStop(id) : Effect.void)),
        );
      }),
    );

  const skip: WorkflowServiceContract["skip"] = (agentRunId) =>
    Effect.suspend(() => {
      for (const control of controls.values()) {
        const skipped = control.skips.get(agentRunId);
        if (skipped) return Deferred.succeed(skipped, undefined).pipe(Effect.asVoid);
      }
      return Effect.fail(
        new WorkflowNotFoundError({
          message: `No queued or running workflow agent ${agentRunId}.`,
        }),
      );
    });

  // Runs this session's earlier activation left running were torn down without a word; tell
  // the main agent once, so it doesn't keep waiting for their results. Each stays open in the
  // journal until its notice is accepted.
  for (const interrupted of yield* journal.interruptedRuns)
    yield* report(interrupted.runId, interruptedWorkflowNotification(interrupted));

  return WorkflowService.of({
    start,
    stop,
    status: requireRun,
    list: SubscriptionRef.get(state),
    skip,
    changes: SubscriptionRef.changes(state),
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
