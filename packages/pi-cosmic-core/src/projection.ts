import {
  hasObjectRuntimeType,
  isBooleanValue,
  isNumberValue,
  isStringValue,
  isSymbolValue,
  runtimeTypeName,
} from "./runtime-values.ts";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

export class ProjectionError extends Schema.TaggedError<ProjectionError>()("ProjectionError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export interface FrozenProjection<State, Snapshot> {
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
  isNumberValue(key) ? `${path}[${key}]` : `${path}.${key}`;

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

const ProjectionDataSchema: Schema.Codec<ProjectionData> = Schema.Tree(
  Schema.Union([Schema.Undefined, Schema.Null, Schema.String, Schema.Number, Schema.Boolean]),
);

const cloneAndFreeze = <Value>(
  value: Value,
  seen: WeakMap<object, ProjectionData>,
  path: string,
): ProjectionData => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (isStringValue(value) || isBooleanValue(value)) return value;
  if (isNumberValue(value)) {
    if (!Schema.is(Schema.Number)(value)) return unsupported(path, "non-finite number");
    return value;
  }
  const kind = runtimeTypeName(value);
  if (kind === "function" || kind === "symbol" || kind === "bigint") return unsupported(path, kind);
  if (!hasObjectRuntimeType(value) || value === null) return unsupported(path, kind);

  const object = value;
  const prior = seen.get(object);
  if (prior !== undefined) return prior;

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeyCount = value.length + 1;
    if (ownKeys.length !== expectedKeyCount)
      return unsupported(path, "array with extra or symbol-keyed properties");

    const clone: ProjectionData[] = [];
    seen.set(object, clone);
    for (let index = 0; index < value.length; index++) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return unsupported(childPath(path, index), "sparse array entry");
      if (!("value" in descriptor) || !descriptor.enumerable)
        return unsupported(childPath(path, index), "non-data array entry");
      clone.push(cloneAndFreeze(descriptor.value, seen, childPath(path, index)));
    }
    return Object.freeze(clone);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return unsupported(path, prototype?.constructor?.name ?? "non-plain object");

  const ownKeys = Reflect.ownKeys(object);
  if (ownKeys.some((key) => isSymbolValue(key))) unsupported(path, "symbol-keyed property");

  const clone: ProjectionRecord = {};
  seen.set(object, clone);
  for (const key of ownKeys) {
    if (!isStringValue(key)) return unsupported(path, "symbol-keyed property");
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return unsupported(childPath(path, key), "missing property descriptor");
    if (!("value" in descriptor)) return unsupported(childPath(path, key), "accessor");
    if (!descriptor.enumerable) return unsupported(childPath(path, key), "non-enumerable property");
    Object.defineProperty(clone, key, {
      value: cloneAndFreeze(descriptor.value, seen, childPath(path, key)),
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  return Object.freeze(clone);
};

/** Clones and deeply freezes a schema-validated plain-data snapshot. */
export const freezeSnapshot = <Snapshot>(snapshot: Snapshot): Snapshot => {
  const cloned = cloneAndFreeze(snapshot, new WeakMap(), "$");
  if (!Schema.is(ProjectionDataSchema)(cloned))
    return unsupported("$", "value outside the projection schema");
  // SAFETY: Recursive cloning preserved the caller's plain-data structure and Schema.Tree validated it.
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
  publish?: (snapshot: Snapshot) => void,
): Effect.Effect<FrozenProjection<State, Snapshot>, ProjectionError> =>
  Effect.gen(function* () {
    const initialSnapshot = yield* projectSnapshot(initialState, project);
    const state = yield* SynchronizedRef.make(initialState);
    const snapshot = MutableRef.make(initialSnapshot);
    if (publish) {
      yield* Effect.try({
        try: () => publish(initialSnapshot),
        catch: () => projectionError("$", "Unable to publish the initial snapshot."),
      });
    }

    const transition: FrozenProjection<State, Snapshot>["transition"] = (update) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        update(current).pipe(
          Effect.flatMap(([result, next]) =>
            projectSnapshot(next, project).pipe(
              Effect.flatMap((published) =>
                Effect.try({
                  try: () => {
                    publish?.(published);
                    MutableRef.set(snapshot, published);
                    return [result, next] as const;
                  },
                  catch: () => projectionError("$", "Unable to publish the snapshot."),
                }),
              ),
            ),
          ),
        ),
      );

    return {
      getSnapshot: () => MutableRef.get(snapshot),
      getState: SynchronizedRef.get(state),
      transition,
    };
  });
