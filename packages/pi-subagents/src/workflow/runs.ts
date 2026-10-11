import * as Clock from "effect/Clock";
import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { WorkflowNotFoundError } from "./errors.ts";
import type { WorkflowFailure, WorkflowRunView } from "./model.ts";
import { withWorkflowEvent, type WorkflowEvent } from "./state.ts";

export interface WorkflowRunControl {
  calls: number;
  readonly skips: Map<string, Deferred.Deferred<void>>;
  readonly stop: Deferred.Deferred<void>;
  readonly failed: Deferred.Deferred<WorkflowFailure>;
  readonly journalLock: Semaphore.Semaphore;
  journal: { written: boolean; warned: boolean; results: number };
}

export const workflowNotFound = (id: string): Effect.Effect<never, WorkflowNotFoundError> =>
  Effect.fail(
    new WorkflowNotFoundError({
      message: `No workflow run ${id} in this session. A run from before a reload or Pi restart can't be controlled here, and another session's runs, or runs whose files were pruned, aren't known.`,
    }),
  );

export const WORKFLOW_ACTIVITY_PUBLISH_MS = 75;

export interface WorkflowActivitySink {
  readonly publish: (runs: ReadonlyArray<WorkflowRunView>) => void;
}

export interface WorkflowRuns {
  readonly list: Effect.Effect<ReadonlyArray<WorkflowRunView>>;
  readonly find: (id: string) => Effect.Effect<WorkflowRunView | undefined>;
  readonly require: (id: string) => Effect.Effect<WorkflowRunView, WorkflowNotFoundError>;
  readonly mutate: (
    change: (runs: ReadonlyArray<WorkflowRunView>) => ReadonlyArray<WorkflowRunView>,
  ) => Effect.Effect<void>;
  readonly modifyEffect: <A>(
    id: string,
    change: (run: WorkflowRunView) => Effect.Effect<readonly [A, WorkflowRunView]>,
  ) => Effect.Effect<A | undefined>;
  readonly modify: <A>(
    id: string,
    change: (run: WorkflowRunView) => readonly [A, WorkflowRunView],
  ) => Effect.Effect<A | undefined>;
  readonly update: (
    id: string,
    change: (run: WorkflowRunView) => WorkflowRunView,
  ) => Effect.Effect<WorkflowRunView | undefined>;
  readonly recordEvent: (id: string, event: WorkflowEvent) => Effect.Effect<void>;
  readonly controls: Map<string, WorkflowRunControl>;
}

const changesRunStates = (
  before: ReadonlyArray<WorkflowRunView>,
  after: ReadonlyArray<WorkflowRunView>,
): boolean =>
  before.length !== after.length ||
  after.some((run, index) => before[index]?.id !== run.id || before[index]?.state !== run.state);

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
  let dirty = false;
  let scheduled = false;

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
        return change(current).pipe(
          Effect.map(([value, updated]) =>
            updated === current
              ? [[value, undefined], runs]
              : [[value, current.state !== updated.state], runs.with(index, updated)],
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
        (run) => run !== undefined,
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
    controls: new Map<string, WorkflowRunControl>(),
  } satisfies WorkflowRuns;
});
