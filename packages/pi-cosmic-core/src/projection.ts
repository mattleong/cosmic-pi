import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { nodeIsProxy } from "./platform/node-builtins.ts";
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

const projectionError = (path: string, message: string) => ProjectionError.make({ path, message });

const unsupported = (path: string, kind: string): never => {
  throw projectionError(path, `Projection snapshot value at ${path} is not plain data (${kind}).`);
};

const childPath = (path: string, key: string | number): string =>
  Predicate.isNumber(key) ? `${path}[${key}]` : `${path}.${key}`;

/** A snapshot location, formatted only when a check fails. */
interface SnapshotPath {
  readonly parent: SnapshotPath | undefined;
  readonly key: string | number;
}

const rootPath: SnapshotPath = { parent: undefined, key: "$" };

const formatPath = (path: SnapshotPath): string =>
  path.parent === undefined ? `${path.key}` : childPath(formatPath(path.parent), path.key);

const unsupportedAt = (path: SnapshotPath, kind: string): never =>
  unsupported(formatPath(path), kind);

const unsupportedChild = (parent: SnapshotPath, key: string | number, kind: string): never =>
  unsupportedAt({ parent, key }, kind);

/**
 * Containers this copy of core validated, copied, and deeply froze. Their contents can no longer
 * change, so later snapshots reuse them by reference instead of validating and copying them again.
 */
const frozenByCore = new WeakSet<object>();

interface SnapshotWalk {
  /** Finished copies by source container, so shared references stay shared. */
  readonly copies: Map<object, object>;
  readonly activePaths: Map<object, SnapshotPath>;
  firstProxy: object | undefined;
}

type CopiedEntry = readonly [key: string | number, copy: object];

const checkedPrimitive = <Value>(
  value: Value,
  parent: SnapshotPath | undefined,
  key: string | number,
): Value => {
  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) unsupportedAt({ parent, key }, "non-finite number");
  } else if (
    !Predicate.isString(value) &&
    !Predicate.isBoolean(value) &&
    !Predicate.isNullish(value)
  )
    unsupportedAt({ parent, key }, runtimeTypeName(value));
  return value;
};

const copyChild = <Value>(
  walk: SnapshotWalk,
  value: Value,
  parent: SnapshotPath,
  key: string | number,
) => {
  if (!Predicate.isObjectOrArray(value)) return checkedPrimitive(value, parent, key);
  if (frozenByCore.has(value)) return value;
  const activePath = walk.activePaths.get(value);
  if (activePath !== undefined)
    unsupportedChild(parent, key, `cyclic reference to ${formatPath(activePath)}`);
  return walk.copies.get(value) ?? copyContainer(walk, value, { parent, key });
};

/** Copies a validated data property's value, recording it when the copy is a new container. */
const copyEntry = (
  walk: SnapshotWalk,
  copied: Array<CopiedEntry>,
  descriptor: PropertyDescriptor,
  parent: SnapshotPath,
  key: string | number,
): void => {
  const value: unknown = descriptor.value;
  const copy = copyChild(walk, value, parent, key);
  if (copy !== value && Predicate.isObjectOrArray(copy)) copied.push([key, copy]);
};

const copyArray = <Entries extends ReadonlyArray<unknown>>(
  walk: SnapshotWalk,
  entries: Entries,
  path: SnapshotPath,
): Entries => {
  if (Reflect.ownKeys(entries).length !== entries.length + 1)
    unsupportedAt(path, "array with extra or symbol-keyed properties");
  const copied: Array<CopiedEntry> = [];
  for (let index = 0; index < entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, index);
    if (!descriptor) unsupportedChild(path, index, "sparse array entry");
    else if (!("value" in descriptor) || !descriptor.enumerable)
      unsupportedChild(path, index, "non-data array entry");
    else copyEntry(walk, copied, descriptor, path, index);
  }
  // Every entry is now known to be enumerable data, so copying reads no accessors.
  const copy = Object.assign([], entries);
  for (const [index, child] of copied) Reflect.set(copy, index, child);
  return copy;
};

const copyRecord = <Container extends object>(
  walk: SnapshotWalk,
  record: Container,
  path: SnapshotPath,
): Container => {
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    const owner = Predicate.hasProperty(prototype, "constructor")
      ? prototype.constructor
      : undefined;
    unsupportedAt(path, Predicate.isFunction(owner) ? owner.name : "non-plain object");
  }
  const ownKeys = Reflect.ownKeys(record);
  if (!Arr.every(ownKeys, (key) => Predicate.isString(key)))
    return unsupportedAt(path, "symbol-keyed property");
  const copied: Array<CopiedEntry> = [];
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) unsupportedChild(path, key, "missing property descriptor");
    else if (!("value" in descriptor)) unsupportedChild(path, key, "accessor");
    else if (!descriptor.enumerable) unsupportedChild(path, key, "non-enumerable property");
    else copyEntry(walk, copied, descriptor, path, key);
  }
  // Every property is now known to be enumerable data, so spreading reads no accessors. Spread
  // also defines an own `__proto__` key as data rather than changing the copy's prototype.
  const copy = { ...record };
  for (const [key, child] of copied) Reflect.set(copy, key, child);
  return copy;
};

/** Validates a container depth-first and returns its frozen copy, which later snapshots reuse. */
const copyContainer = <Container extends object>(
  walk: SnapshotWalk,
  container: Container,
  path: SnapshotPath,
): Container => {
  if (nodeIsProxy(container)) walk.firstProxy ??= container;
  walk.activePaths.set(container, path);
  const copy = Arr.isArray(container)
    ? copyArray(walk, container, path)
    : copyRecord(walk, container, path);
  walk.activePaths.delete(container);
  Object.freeze(copy);
  frozenByCore.add(copy);
  walk.copies.set(container, copy);
  return copy;
};

export const freezeSnapshot = <Snapshot>(snapshot: Snapshot): Snapshot => {
  if (!Predicate.isObjectOrArray(snapshot)) return checkedPrimitive(snapshot, undefined, "$");
  if (frozenByCore.has(snapshot)) return snapshot;
  const walk: SnapshotWalk = { copies: new Map(), activePaths: new Map(), firstProxy: undefined };
  const copy = copyContainer(walk, snapshot, rootPath);
  // The structured clone this copy replaces rejected proxies once validation passed; cloning
  // the first one natively throws the same DataCloneError.
  if (walk.firstProxy !== undefined) structuredClone(walk.firstProxy);
  return copy;
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
        // The published snapshot already projects an unchanged state.
        if (Object.is(next, current)) return result;
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
