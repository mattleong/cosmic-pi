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
  readonly getSnapshot: () => Snapshot;
  readonly getState: Effect.Effect<State>;
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

const checkArray = (
  value: ReadonlyArray<unknown>,
  checked: WeakSet<object>,
  activePaths: WeakMap<object, string>,
  path: string,
): void => {
  if (Reflect.ownKeys(value).length !== value.length + 1)
    unsupported(path, "array with extra or symbol-keyed properties");
  for (let index = 0; index < value.length; index++) {
    const at = childPath(path, index);
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) unsupported(at, "sparse array entry");
    else if (!("value" in descriptor) || !descriptor.enumerable)
      unsupported(at, "non-data array entry");
    else checkPlainData(descriptor.value, checked, activePaths, at);
  }
};

const constructorName = <Prototype>(prototype: Prototype): string => {
  if (!Predicate.hasProperty(prototype, "constructor")) return "non-plain object";
  const { constructor } = prototype;
  return Predicate.isFunction(constructor) ? constructor.name : "non-plain object";
};

const checkRecord = <Candidate extends object>(
  value: Candidate,
  checked: WeakSet<object>,
  activePaths: WeakMap<object, string>,
  path: string,
): void => {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    unsupported(path, constructorName(prototype));
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every((key) => Predicate.isString(key)))
    return unsupported(path, "symbol-keyed property");
  for (const key of ownKeys) {
    const at = childPath(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) unsupported(at, "missing property descriptor");
    else if (!("value" in descriptor)) unsupported(at, "accessor");
    else if (!descriptor.enumerable) unsupported(at, "non-enumerable property");
    else checkPlainData(descriptor.value, checked, activePaths, at);
  }
};

const checkPlainData = <Value>(
  value: Value,
  checked: WeakSet<object>,
  activePaths: WeakMap<object, string>,
  path: string,
): void => {
  if (value === undefined || value === null) return;
  if (Predicate.isString(value) || Predicate.isBoolean(value)) return;
  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) unsupported(path, "non-finite number");
    return;
  }
  if (!Predicate.isObjectOrArray(value)) return void unsupported(path, runtimeTypeName(value));
  const activePath = activePaths.get(value);
  if (activePath !== undefined) unsupported(path, `cyclic reference to ${activePath}`);
  if (checked.has(value)) return;
  activePaths.set(value, path);
  if (Array.isArray(value)) checkArray(value, checked, activePaths, path);
  else checkRecord(value, checked, activePaths, path);
  activePaths.delete(value);
  checked.add(value);
};

const deepFreeze = <Value>(value: Value): void => {
  if (!Predicate.isObjectOrArray(value) || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

export const freezeSnapshot = <Snapshot>(snapshot: Snapshot): Snapshot => {
  checkPlainData(snapshot, new WeakSet(), new WeakMap(), "$");
  const clone = structuredClone(snapshot);
  deepFreeze(clone);
  return clone;
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
