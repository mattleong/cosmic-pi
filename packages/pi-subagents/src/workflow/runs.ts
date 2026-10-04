import * as Clock from "effect/Clock";
import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { WorkflowNotFoundError } from "./errors.ts";
import type { WorkflowFailure, WorkflowRunView } from "./model.ts";
import { withWorkflowEvent, type WorkflowEvent } from "./state.ts";

/** Per-run control state the service alone mutates. */
export interface WorkflowRunControl {
  calls: number;
  readonly skips: Map<string, Deferred.Deferred<void>>;
  /** Completes when the run is asked to stop; the script aborts and keeps its output. */
  readonly stop: Deferred.Deferred<void>;
  /**
   * Completes when the host fails the run, such as for a call past its agent limit: the script
   * aborts and the run fails with this failure, so a script's catch can't keep it going.
   */
  readonly failed: Deferred.Deferred<WorkflowFailure>;
  /** Serializes results journal appends, so concurrent agents never interleave lines. */
  readonly journalLock: Semaphore.Semaphore;
  /**
   * Whether a journal line was written, which shows the file, whether a failure was logged, and
   * how many full results were saved beside the journal.
   */
  journal: { written: boolean; warned: boolean; results: number };
}

/** The refusal for a run this session neither holds nor remembers. */
export const workflowNotFound = (id: string): Effect.Effect<never, WorkflowNotFoundError> =>
  Effect.fail(
    new WorkflowNotFoundError({
      message: `No workflow run ${id} in this session. A run from before a reload or Pi restart can't be controlled here, and another session's runs, or runs whose files were pruned, aren't known.`,
    }),
  );

/** Controls of the runs whose fibers are live, keyed by workflow run id. */
export interface WorkflowRunControls {
  readonly get: (id: string) => WorkflowRunControl | undefined;
  readonly add: (id: string, control: WorkflowRunControl) => void;
  readonly remove: (id: string) => void;
  /** The skip of a queued or running agent in any live run, by its subagent run id. */
  readonly skipOf: (agentRunId: string) => Deferred.Deferred<void> | undefined;
}

/** How long a change waits for later ones before Activity republishes them together. */
export const WORKFLOW_ACTIVITY_PUBLISH_MS = 75;

/**
 * The host's synchronous Activity bridge. A publish runs the host's render work, so the run store
 * coalesces publishes: at most one per {@link WORKFLOW_ACTIVITY_PUBLISH_MS}, at once when a run
 * starts, ends, starts stopping or is evicted. The host checks detail and actions against the
 * views it was last published, the only ones it holds revisions for.
 */
export interface WorkflowActivitySink {
  readonly publish: (runs: ReadonlyArray<WorkflowRunView>) => void;
}

/** A change to every run view, such as adding a run or evicting old ones. */
export type WorkflowRunsChange = (
  runs: ReadonlyArray<WorkflowRunView>,
) => ReadonlyArray<WorkflowRunView>;

/**
 * The session's run views and the controls of its live runs. Every change takes the views' lock
 * and then hands the latest views to one Activity bridge, which coalesces publishes.
 */
export interface WorkflowRuns {
  readonly list: Effect.Effect<ReadonlyArray<WorkflowRunView>>;
  readonly find: (id: string) => Effect.Effect<WorkflowRunView | undefined>;
  readonly require: (id: string) => Effect.Effect<WorkflowRunView, WorkflowNotFoundError>;
  readonly mutate: (change: WorkflowRunsChange) => Effect.Effect<void>;
  /**
   * Atomically applies an effectful `change` to one run, under the views' lock, which also
   * returns a value derived from the run as it was; undefined once the run is evicted.
   */
  readonly modifyEffect: <A>(
    id: string,
    change: (run: WorkflowRunView) => Effect.Effect<readonly [A, WorkflowRunView]>,
  ) => Effect.Effect<A | undefined>;
  /** {@link WorkflowRuns.modifyEffect} with a pure change. */
  readonly modify: <A>(
    id: string,
    change: (run: WorkflowRunView) => readonly [A, WorkflowRunView],
  ) => Effect.Effect<A | undefined>;
  /** Applies `change` to one run and returns the result, or undefined once evicted. */
  readonly update: (
    id: string,
    change: (run: WorkflowRunView) => WorkflowRunView,
  ) => Effect.Effect<WorkflowRunView | undefined>;
  /** Applies a script or service event to one run, stamped with the current time. */
  readonly recordEvent: (id: string, event: WorkflowEvent) => Effect.Effect<void>;
  readonly controls: WorkflowRunControls;
}

const makeControls = (): WorkflowRunControls => {
  const controls = new Map<string, WorkflowRunControl>();
  return {
    get: (id) => controls.get(id),
    add: (id, control) => void controls.set(id, control),
    remove: (id) => void controls.delete(id),
    skipOf: (agentRunId) => {
      for (const control of controls.values()) {
        const skip = control.skips.get(agentRunId);
        if (skip) return skip;
      }
      return undefined;
    },
  };
};

/** Whether a change starts, ends, stops or evicts a run, which Activity shows at once. */
const changesRunStates = (
  before: ReadonlyArray<WorkflowRunView>,
  after: ReadonlyArray<WorkflowRunView>,
): boolean =>
  before.length !== after.length ||
  after.some((run, index) => before[index]?.id !== run.id || before[index]?.state !== run.state);

/**
 * Coalesces the views' publishes to the host's Activity bridge, in the caller's scope. Its
 * finalizers run in reverse: the closed flag first, so a closing session publishes nothing, then
 * a pending publish is dropped.
 */
const makeActivityPublisher = Effect.fnUntraced(function* (
  sink: WorkflowActivitySink | undefined,
  latest: () => ReadonlyArray<WorkflowRunView>,
) {
  const pending = yield* FiberSet.make();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );
  /** Views changed since the last publish. */
  let dirty = false;
  /** A trailing publish is scheduled. */
  let scheduled = false;

  // The only path to the bridge: it always sends the latest views, never a stale change.
  const flush = Effect.suspend(() => {
    if (!sink || closed || !dirty) return Effect.void;
    dirty = false;
    return Effect.try(() => sink.publish(latest())).pipe(Effect.ignore);
  });

  const trailing = flush.pipe(
    Effect.delay(WORKFLOW_ACTIVITY_PUBLISH_MS),
    Effect.ensuring(
      Effect.sync(() => {
        scheduled = false;
      }),
    ),
  );

  /** Publishes a change at once, or with later changes after {@link WORKFLOW_ACTIVITY_PUBLISH_MS}. */
  const changed = (urgent: boolean) =>
    Effect.suspend(() => {
      if (!sink || closed) return Effect.void;
      dirty = true;
      if (urgent) return flush;
      if (scheduled) return Effect.void;
      scheduled = true;
      return FiberSet.run(pending, trailing).pipe(Effect.asVoid);
    });

  return { changed };
});

/**
 * Builds the run store in the caller's scope. `activity` is the host's synchronous bridge for
 * Activity; it receives coalesced publishes until the scope closes.
 */
export const makeWorkflowRuns = Effect.fnUntraced(function* (
  activity: WorkflowActivitySink | undefined,
) {
  const state = yield* SynchronizedRef.make<ReadonlyArray<WorkflowRunView>>([]);
  const publisher = yield* makeActivityPublisher(activity, () => SynchronizedRef.getUnsafe(state));

  const mutate: WorkflowRuns["mutate"] = (change) =>
    SynchronizedRef.modify(state, (before) => {
      const after = change(before);
      return [before === after ? undefined : changesRunStates(before, after), after] as const;
    }).pipe(
      Effect.flatMap((urgent) => (urgent === undefined ? Effect.void : publisher.changed(urgent))),
    );

  const modifyEffect: WorkflowRuns["modifyEffect"] = <A>(
    id: string,
    change: (run: WorkflowRunView) => Effect.Effect<readonly [A, WorkflowRunView]>,
  ) =>
    SynchronizedRef.modifyEffect(
      state,
      (
        runs,
      ): Effect.Effect<
        readonly [readonly [A | undefined, boolean | undefined], ReadonlyArray<WorkflowRunView>]
      > => {
        const index = runs.findIndex((run) => run.id === id);
        const current = runs[index];
        if (!current) return Effect.succeed([[undefined, undefined], runs]);
        // A changed run state, such as a start of stopping or a finish, publishes at once.
        return change(current).pipe(
          Effect.map(
            ([value, updated]) =>
              [[value, current.state !== updated.state], runs.with(index, updated)] as const,
          ),
        );
      },
    ).pipe(
      Effect.flatMap(([value, urgent]) =>
        urgent === undefined
          ? Effect.succeed(value)
          : publisher.changed(urgent).pipe(Effect.as(value)),
      ),
    );

  const modify: WorkflowRuns["modify"] = (id, change) =>
    modifyEffect(id, (run) => Effect.sync(() => change(run)));

  const update: WorkflowRuns["update"] = (id, change) =>
    modify(id, (run) => {
      const updated = change(run);
      return [updated, updated] as const;
    });

  const find: WorkflowRuns["find"] = (id) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((runs) => runs.find((candidate) => candidate.id === id)),
    );

  const require: WorkflowRuns["require"] = (id) =>
    find(id).pipe(
      Effect.filterOrElse(
        (run): run is WorkflowRunView => run !== undefined,
        () => workflowNotFound(id),
      ),
    );

  const recordEvent: WorkflowRuns["recordEvent"] = (id, event) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((at) => update(id, (run) => withWorkflowEvent(run, event, at))),
      Effect.asVoid,
    );

  return {
    list: SynchronizedRef.get(state),
    find,
    require,
    mutate,
    modifyEffect,
    modify,
    update,
    recordEvent,
    controls: makeControls(),
  } satisfies WorkflowRuns;
});
