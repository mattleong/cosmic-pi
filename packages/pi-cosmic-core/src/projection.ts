import * as Predicate from "effect/Predicate";
import { runtimeTypeName } from "./runtime-values.ts";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export class ProjectionError extends Schema.TaggedError<ProjectionError>()("ProjectionError", {
  path: Schema.String,
  message: Schema.String,
}) {}

interface FrozenProjection<State, Snapshot> {
  /** Synchronous renderer boundary. The returned value is deeply frozen plain data. */
  readonly getSnapshot: () => Snapshot;
  /** Effect-owned authoritative state read; no Ref is exposed. */
  readonly getState: Effect.Effect<State>;
  /** Serialized transition. Publication happens only after the transition and projection succeed. */
  readonly transition: <A, E, R>(
    update: (state: State) => Effect.Effect<readonly [A, State], E, R>,
  ) => Effect.Effect<A, E | ProjectionError, R>;
}

const projectionError = (path: string, message: string) => new ProjectionError({ path, message });

const unsupported = (path: string, kind: string): never => {
  throw projectionError(path, `Projection snapshot value at ${path} is not plain data (${kind}).`);
};

const childPath = (path: string, key: string | number): string =>
  Predicate.isNumber(key) ? `${path}[${key}]` : `${path}.${key}`;

interface ProjectionRecord {
  [key: string]: ProjectionData;
}
type ProjectionData =
  | undefined
  | null
  | string
  | number
  | boolean
  | ReadonlyArray<ProjectionData>
  | ProjectionRecord;

const cloneAndFreeze = <Value>(
  value: Value,
  seen: WeakMap<object, ProjectionData>,
  activePaths: WeakMap<object, string>,
  path: string,
): ProjectionData => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Predicate.isString(value) || Predicate.isBoolean(value)) return value;
  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) return unsupported(path, "non-finite number");
    return value;
  }
  // Functions, symbols, and bigints are the only kinds left.
  if (!Predicate.isObjectOrArray(value)) return unsupported(path, runtimeTypeName(value));

  const activePath = activePaths.get(value);
  if (activePath !== undefined) return unsupported(path, `cyclic reference to ${activePath}`);
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  activePaths.set(value, path);

  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1)
      return unsupported(path, "array with extra or symbol-keyed properties");

    const clone: ProjectionData[] = [];
    seen.set(value, clone);
    for (let index = 0; index < value.length; index++) {
      const at = childPath(path, index);
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor) return unsupported(at, "sparse array entry");
      if (!("value" in descriptor) || !descriptor.enumerable)
        return unsupported(at, "non-data array entry");
      clone.push(cloneAndFreeze(descriptor.value, seen, activePaths, at));
    }
    activePaths.delete(value);
    return Object.freeze(clone);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return unsupported(path, prototype?.constructor?.name ?? "non-plain object");

  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every((key) => Predicate.isString(key)))
    return unsupported(path, "symbol-keyed property");

  const clone: ProjectionRecord = {};
  seen.set(value, clone);
  for (const key of ownKeys) {
    const at = childPath(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return unsupported(at, "missing property descriptor");
    if (!("value" in descriptor)) return unsupported(at, "accessor");
    if (!descriptor.enumerable) return unsupported(at, "non-enumerable property");
    Object.defineProperty(clone, key, {
      value: cloneAndFreeze(descriptor.value, seen, activePaths, at),
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  activePaths.delete(value);
  return Object.freeze(clone);
};

/** Clones and deeply freezes a plain-data snapshot, rejecting non-plain values with typed paths. */
export const freezeSnapshot = <Snapshot>(snapshot: Snapshot): Snapshot => {
  const cloned = cloneAndFreeze(snapshot, new WeakMap(), new WeakMap(), "$");
  // SAFETY: cloneAndFreeze structurally validated every value while cloning, so the frozen clone
  // preserves the caller's plain-data snapshot shape.
  return cloned as Snapshot;
};

const projectSnapshot = <State, Snapshot>(
  state: State,
  project: (state: State) => Snapshot,
): Effect.Effect<Snapshot, ProjectionError> =>
  Effect.try({
    try: () => freezeSnapshot(project(state)),
    catch: (error) =>
      error instanceof ProjectionError
        ? error
        : projectionError("$", "Unable to publish a plain immutable state snapshot."),
  });

/** Creates one authoritative synchronized state with an immutable synchronous snapshot projection. */
export const makeFrozenProjection = <State, Snapshot>(
  initialState: State,
  project: (state: State) => Snapshot,
  publish: (snapshot: Snapshot) => void,
): Effect.Effect<FrozenProjection<State, Snapshot>, ProjectionError> =>
  Effect.gen(function* () {
    const initialSnapshot = yield* projectSnapshot(initialState, project);
    const state = yield* Ref.make(initialState);
    const lock = yield* Semaphore.make(1);
    const snapshot = MutableRef.make(initialSnapshot);
    yield* Effect.try({
      try: () => publish(initialSnapshot),
      catch: () => projectionError("$", "Unable to publish the initial snapshot."),
    });

    const transition: FrozenProjection<State, Snapshot>["transition"] = (update) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const [result, next] = yield* update(current);
          const published = yield* projectSnapshot(next, project);
          // Preparation and lock waiting remain interruptible. Once publication starts,
          // include the backing Ref commit in the same protected transaction.
          yield* Effect.uninterruptible(
            Effect.try({
              try: () => {
                publish(published);
                MutableRef.set(snapshot, published);
              },
              catch: () => projectionError("$", "Unable to publish the snapshot."),
            }).pipe(Effect.andThen(Ref.set(state, next))),
          );
          return result;
        }),
      );

    return {
      getSnapshot: () => MutableRef.get(snapshot),
      getState: Ref.get(state),
      transition,
    };
  });
