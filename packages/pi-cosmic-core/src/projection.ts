import * as Arr from "effect/Array";
import { constVoid } from "effect/Function";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { runtimeTypeName } from "./runtime-values.ts";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export class ProjectionError extends Schema.TaggedError<
  ProjectionError,
  { readonly brand: unique symbol }
>()("ProjectionError", {
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

const isProjectionError = Schema.is(ProjectionError);

const projectionError = (path: string, message: string) => new ProjectionError({ path, message });

const unsupported = (path: string, kind: string): never => {
  throw projectionError(path, `Projection snapshot value at ${path} is not plain data (${kind}).`);
};

const childPath = (path: string, key: string | number): string =>
  Predicate.isNumber(key) ? `${path}[${key}]` : `${path}.${key}`;

interface PlainDataWalk {
  readonly checked: WeakSet<object>;
  readonly activePaths: WeakMap<object, string>;
}

const tracked = <Container extends object>(
  walk: PlainDataWalk,
  path: string,
  container: Container,
  check: (container: Container) => void,
): void => {
  const activePath = walk.activePaths.get(container);
  if (activePath !== undefined) unsupported(path, `cyclic reference to ${activePath}`);
  if (walk.checked.has(container)) return;
  walk.activePaths.set(container, path);
  check(container);
  walk.activePaths.delete(container);
  walk.checked.add(container);
};

const checkArray = (walk: PlainDataWalk, path: string, entries: ReadonlyArray<unknown>): void => {
  if (Reflect.ownKeys(entries).length !== entries.length + 1)
    unsupported(path, "array with extra or symbol-keyed properties");
  for (let index = 0; index < entries.length; index++) {
    const at = childPath(path, index);
    const descriptor = Object.getOwnPropertyDescriptor(entries, index);
    if (!descriptor) unsupported(at, "sparse array entry");
    else if (!("value" in descriptor) || !descriptor.enumerable)
      unsupported(at, "non-data array entry");
    else plainDataAt(walk, at)(descriptor.value);
  }
};

const plainDataAt = (walk: PlainDataWalk, path: string) =>
  Match.type<unknown>().pipe(
    Match.when(Predicate.isUndefined, constVoid),
    Match.when(Predicate.isNull, constVoid),
    Match.when(Predicate.isString, constVoid),
    Match.when(Predicate.isBoolean, constVoid),
    Match.when(Predicate.isNumber, (count): void => {
      if (!Number.isFinite(count)) unsupported(path, "non-finite number");
    }),
    Match.when(Arr.isArray, (entries): void =>
      tracked(walk, path, entries, (array) => checkArray(walk, path, array)),
    ),
    Match.when(Predicate.isObject, (record): void =>
      tracked(walk, path, record, (object) => {
        const prototype: unknown = Object.getPrototypeOf(object);
        if (prototype !== Object.prototype && prototype !== null) {
          const owner = Predicate.hasProperty(prototype, "constructor")
            ? prototype.constructor
            : undefined;
          unsupported(path, Predicate.isFunction(owner) ? owner.name : "non-plain object");
        }
        const ownKeys = Reflect.ownKeys(object);
        if (!ownKeys.every((key) => Predicate.isString(key))) {
          unsupported(path, "symbol-keyed property");
          return;
        }
        for (const key of ownKeys) {
          const at = childPath(path, key);
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (!descriptor) unsupported(at, "missing property descriptor");
          else if (!("value" in descriptor)) unsupported(at, "accessor");
          else if (!descriptor.enumerable) unsupported(at, "non-enumerable property");
          else plainDataAt(walk, at)(descriptor.value);
        }
      }),
    ),
    Match.orElse((other): void => unsupported(path, runtimeTypeName(other))),
  );

const deepFreeze = Match.type<unknown>().pipe(
  Match.when(Predicate.isObjectOrArray, (container): void => {
    if (Object.isFrozen(container)) return;
    Object.freeze(container);
    for (const child of Object.values(container)) deepFreeze(child);
  }),
  Match.orElse(constVoid),
);

export const freezeSnapshot = <Snapshot>(snapshot: Snapshot): Snapshot => {
  plainDataAt({ checked: new WeakSet(), activePaths: new WeakMap() }, "$")(snapshot);
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
      isProjectionError(error)
        ? error
        : projectionError("$", "Unable to publish a plain immutable state snapshot."),
  });

export const frozenProjection = Effect.fn("Projection.frozenProjection")(function* <
  State,
  Snapshot,
>(
  initialState: State,
  project: (state: State) => Snapshot,
  publish: (snapshot: Snapshot) => void,
): Effect.fn.Return<FrozenProjection<State, Snapshot>, ProjectionError> {
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
