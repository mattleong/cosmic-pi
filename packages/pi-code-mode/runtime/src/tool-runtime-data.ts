import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "./runtime-values.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
  queryPairsUpperBound,
} from "./interpreter/confinement.js";
import {
  type InterpreterValue,
  makeInterpreterObject,
  ToolReference,
  GeneratorReference,
} from "./interpreter/model.js";
import { isoString } from "./stdlib/epoch.js";
import { ToolRuntimeError } from "./tool-runtime-error.js";
import {
  SandboxBytes,
  SandboxTextEncoder,
  SandboxTextDecoder,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
  isErrorValue,
} from "./values.js";
import { isNativeIterator } from "./interpreter/iterator-protocol.js";

/**
 * Maximum nesting depth for values crossing a data boundary. Fixed (not a configurable
 * limit) purely because it produces a clearer diagnostic than a native stack-overflow
 * RangeError would.
 */
const MAX_VALUE_DEPTH = 32;

// Admit a full-size collection of key/value pairs, including pair containers and root.
// Count expanded occurrences, not distinct objects: tiny DAGs can allocate huge trees.
const MAX_DATA_VISITS = 3 * MAX_GUEST_COLLECTION_ENTRIES + 1;
const MAX_DATA_CONTAINERS = MAX_GUEST_COLLECTION_ENTRIES + 1;
// Six code units cover a JSON escape; 32 cover any scalar and structural punctuation.
// This is independent of host output/retention policy and admits a maximum-size string.
const MAX_DATA_UNITS = 6 * MAX_GUEST_STRING_LENGTH + 32 * MAX_DATA_VISITS;

type Measured<Value> = {
  value: Value;
  visits: number;
  units: number;
  containers: number;
  slots: number;
};

class ProjectionBudget<Value> {
  private visits = 0;
  private units = 0;
  private containers = 0;
  private slots = 0;
  private memo = new WeakMap<object, Map<number, Measured<Value>>>();
  private accessorEpoch = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  charge(visits: number, units = 32 * visits, containers = 0, slots = 0): void {
    this.visits += visits;
    this.units += units;
    this.containers += containers;
    this.slots += slots;
    if (
      this.visits > MAX_DATA_VISITS ||
      this.slots > MAX_DATA_VISITS ||
      this.units > MAX_DATA_UNITS ||
      this.containers > MAX_DATA_CONTAINERS
    ) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${this.label} exceeds the expanded data budget.`,
      );
    }
  }

  // Accessor results belong to an occurrence, not an identity. Changing the epoch also
  // prevents every active ancestor from caching accessor-dependent descendants.
  inspectAccessors<Input extends object>(value: Input): void {
    let current: object | null = value;
    do {
      for (const key of Object.getOwnPropertyNames(current)) {
        // Array mapping reads inherited indices too, but not unrelated prototype getters.
        if (current !== value && key !== "map" && !/^(0|[1-9][0-9]*)$/.test(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor !== undefined && !("value" in descriptor)) {
          this.accessorEpoch++;
          // A getter may mutate data already projected earlier in this traversal.
          this.memo = new WeakMap();
          return;
        }
      }
      current = Array.isArray(value) ? Object.getPrototypeOf(current) : null;
    } while (current !== null);
  }

  project<Input>(input: Input, depth: number, body: () => Value): Value {
    if (depth > MAX_VALUE_DEPTH) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${this.label} exceeds the maximum value depth of ${MAX_VALUE_DEPTH}.`,
      );
    }
    const object = input !== null && hasObjectRuntimeType(input) ? input : undefined;
    const cached = object === undefined ? undefined : this.memo.get(object)?.get(depth);
    if (cached !== undefined) {
      this.charge(cached.visits, cached.units, cached.containers, cached.slots);
      return cached.value;
    }
    const accessorEpoch = this.accessorEpoch;
    const visits = this.visits;
    const units = this.units;
    const containers = this.containers;
    const slots = this.slots;
    this.charge(1, 32, object === undefined ? 0 : 1);
    const value = body();
    if (Predicate.isString(value)) {
      if (value.length > MAX_GUEST_STRING_LENGTH) {
        throw new ToolRuntimeError(
          "InvalidDataValue",
          `${this.label} contains an oversized string.`,
        );
      }
      this.charge(0, 6 * value.length);
    }
    if (object !== undefined && accessorEpoch === this.accessorEpoch) {
      const entries = this.memo.get(object) ?? new Map<number, Measured<Value>>();
      entries.set(depth, {
        value,
        visits: this.visits - visits,
        units: this.units - units,
        containers: this.containers - containers,
        slots: this.slots - slots,
      });
      this.memo.set(object, entries);
    }
    return value;
  }
}

// Projection memoizes only bounded, normalized data. Expansion never revisits host getters
// or calls guest callbacks; its own budget is a backstop before native serialization.
const expandIn = (value: InterpreterValue, budget: ProjectionBudget<never>): InterpreterValue => {
  budget.charge(1, 32, value !== null && hasObjectRuntimeType(value) ? 1 : 0);
  if (Array.isArray(value)) {
    budget.charge(0, 0, 0, value.length);
    let present = 0;
    const result = value.map((item) => {
      present++;
      return expandIn(item, budget);
    });
    budget.charge(value.length - present);
    return result;
  }
  if (
    value !== null &&
    hasObjectRuntimeType(value) &&
    Object.getPrototypeOf(value) === null &&
    !isErrorValue(value)
  ) {
    const entries = Object.entries(value);
    budget.charge(0, 0, 0, entries.length);
    const result = makeInterpreterObject();
    for (const [key, item] of entries) result[key] = expandIn(item, budget);
    return result;
  }
  return value;
};

const blockedMemberNames = new Set(["__proto__", "constructor", "prototype"]);

/** Names that reach a prototype on any object that has one. */
export const isBlockedMember = (name: string): boolean => blockedMemberNames.has(name);

/**
 * Whether `key` is ordinary data on `target`. Guest objects have no prototype, so every name
 * is an own data property there; on arrays and other objects the prototype names stay blocked.
 */
export const isDataKeyOf = (target: InterpreterValue, key: PropertyKey): boolean =>
  !Predicate.isString(key) ||
  !isBlockedMember(key) ||
  (target !== null && hasObjectRuntimeType(target) && Object.getPrototypeOf(target) === null);

/**
 * Validates and copies a value against the plain-data contract (depth, circularity, plain
 * objects only, blocked properties, data-only leaves).
 *
 * Two modes share the walk:
 * - **Boundary** (`preserveSandboxValues` false, the default): the host<->sandbox boundary -
 *   final results, tool-call arguments, `JSON.stringify`. Sandbox value types serialize
 *   exactly as JSON.stringify would: Date/URL -> strings, the remaining value types -> {}.
 * - **Intra-sandbox checkpoint** (`preserveSandboxValues` true; see `boundedData` in
 *   codemode.ts): standard-library value instances pass through untouched (treated as leaves,
 *   contents not walked), so values flowing through `Object.*` helpers, coercion inputs, and
 *   other in-sandbox checkpoints stay fully usable (`.getTime()`, `.has()`, ...).
 *
 * Both modes reject un-awaited promises with an await-hinting diagnostic.
 */
export const copyIn = <Value>(
  value: Value,
  label: string,
  preserveSandboxValues = false,
): InterpreterValue => {
  const projected = copyBounded(
    value,
    label,
    0,
    new Set(),
    preserveSandboxValues,
    new ProjectionBudget(label),
  );
  return expandIn(projected, new ProjectionBudget(label));
};

/**
 * Guest data leaving the sandbox as JSON data: validated and bounded against the data
 * contract, then copied out with JSON semantics (see copyOut). The final result uses this;
 * tool arguments use the same projection with one budget across the argument list.
 */
export const exportData = (value: InterpreterValue, label: string): SerializableValue =>
  copyOut(copyBounded(value, label, 0, new Set(), false, new ProjectionBudget(label)));

// The argument list shares one budget; resetting it per argument permits amplification
// through many individually valid arguments. The list itself is not a data container.
export const copyArguments = (
  args: ReadonlyArray<InterpreterValue>,
  label: string,
): Array<SerializableValue> => {
  const budget = new ProjectionBudget<InterpreterValue>(label);
  const projected = args.map((arg) => copyBounded(arg, label, 0, new Set(), false, budget));
  const copied = projected.map((arg) => copyOut(arg));
  for (const arg of copied) rejectProtoKeys(arg, label);
  return copied;
};

// Host tools may merge their input with ordinary assignment, where a "__proto__" key would
// replace an object's prototype. Guest data can hold the key; tool input cannot.
const rejectProtoKeys = (value: SerializableValue, label: string): void => {
  if (value === null || !hasObjectRuntimeType(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) rejectProtoKeys(item, label);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__")
      throw new ToolRuntimeError("InvalidDataValue", `${label} contains the key "__proto__".`);
    rejectProtoKeys(item, label);
  }
};

const copyBounded = <Value>(
  value: Value,
  label: string,
  depth: number,
  seen: Set<object>,
  preserveSandboxValues: boolean,
  budget: ProjectionBudget<InterpreterValue>,
): InterpreterValue =>
  budget.project(value, depth, () => {
    // Confinement: string leaves and collection sizes are bounded at every data checkpoint,
    // so amplified intermediates are refused wherever they first cross shared machinery.
    if (Predicate.isString(value)) {
      if (value.length > MAX_GUEST_STRING_LENGTH) {
        throw new ToolRuntimeError(
          "InvalidDataValue",
          `${label} contains a string of ${value.length} characters, over the CodeMode maximum of ${MAX_GUEST_STRING_LENGTH}.`,
        );
      }
      return value;
    }
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (Predicate.isBoolean(value)) return value;
    // NaN/Infinity are allowed to exist as in-sandbox intermediates (matching real JS and a real
    // engine) so defensive guards like `Number.isNaN(x)` / `parseInt(x) || 0` can run. They are
    // normalized to `null` when the value leaves the sandbox - see copyOut - exactly as
    // JSON.stringify already does at any tool boundary.
    if (Predicate.isNumber(value)) return value;

    if (!hasObjectRuntimeType(value)) {
      throw new ToolRuntimeError("InvalidDataValue", `${label} must contain data only.`);
    }

    // Iterators are cursors, not data; name the conversion instead of a generic shape error.
    if (value instanceof GeneratorReference || isNativeIterator(value)) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${label} contains an iterator; convert it to an array first, for example [...iterator] or iterator.toArray().`,
      );
    }

    // An un-awaited promise never crosses a data checkpoint as `{}`; the diagnostic tells the
    // model exactly how to fix the program instead.
    if (value instanceof SandboxPromise) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${label} contains an un-awaited Promise; await tool calls (e.g. \`const result = await tools.ns.tool(...)\`) before using their results.`,
      );
    }

    if (
      value instanceof SandboxBytes ||
      value instanceof SandboxTextEncoder ||
      value instanceof SandboxTextDecoder
    ) {
      if (preserveSandboxValues) return value;
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${label} contains an opaque byte value; encode bytes as text before crossing a data boundary.`,
      );
    }

    if (preserveSandboxValues) {
      // Intra-sandbox checkpoints keep sandbox value instances alive as leaves; their contents
      // are never walked here (Map/Set members are validated where mutation happens, and the
      // real boundary still serializes them below). Guest errors keep their identity so
      // coercion and instanceof still recognize them.
      if (
        isErrorValue(value) ||
        value instanceof SandboxDate ||
        value instanceof SandboxRegExp ||
        value instanceof SandboxMap ||
        value instanceof SandboxSet ||
        value instanceof SandboxURL ||
        value instanceof SandboxURLSearchParams
      ) {
        return value;
      }
      // Host instances cannot normally reach an intra-sandbox checkpoint (tool results cross
      // the boundary first), but wrap them defensively rather than degrading to JSON forms.
      if (value instanceof Date) return new SandboxDate(value.getTime());
      if (value instanceof RegExp) return new SandboxRegExp(value.source, value.flags);
      if (value instanceof Map) {
        const wrapped = new SandboxMap();
        for (const [key, item] of value.entries()) {
          wrapped.map.set(
            copyBounded(key, label, depth + 1, seen, true, budget),
            copyBounded(item, label, depth + 1, seen, true, budget),
          );
        }
        return wrapped;
      }
      if (value instanceof Set) {
        const wrapped = new SandboxSet();
        for (const item of value.values())
          wrapped.set.add(copyBounded(item, label, depth + 1, seen, true, budget));
        return wrapped;
      }
      if (value instanceof URL) {
        // Confinement preflight: charge the host URL's query pair count before the
        // SandboxURL wrapper eagerly materializes its searchParams entry list.
        if (queryPairsUpperBound(value.search) > MAX_GUEST_COLLECTION_ENTRIES) {
          throw new ToolRuntimeError(
            "InvalidDataValue",
            `${label} URL query would parse into more than ${MAX_GUEST_COLLECTION_ENTRIES} parameters.`,
          );
        }
        return new SandboxURL(new URL(value.href));
      }
      if (value instanceof URLSearchParams) {
        // Confinement preflight: charge the copy's entry count before the native copy runs.
        if (value.size > MAX_GUEST_COLLECTION_ENTRIES) {
          throw new ToolRuntimeError(
            "InvalidDataValue",
            `${label} URLSearchParams would hold more than ${MAX_GUEST_COLLECTION_ENTRIES} entries.`,
          );
        }
        return new SandboxURLSearchParams(new URLSearchParams(value));
      }
    }

    // Sandbox value types (and their host counterparts, which a host tool may legitimately
    // return) serialize exactly as JSON.stringify would at the data boundary: Date/URL use
    // toJSON(), while RegExp/Map/Set/URLSearchParams have no JSON form beyond {}.
    if (value instanceof SandboxDate) {
      return Number.isFinite(value.time) ? isoString(value.time) : null;
    }
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    if (value instanceof SandboxURL) return value.url.href;
    if (value instanceof URL) return value.href;
    if (
      value instanceof SandboxRegExp ||
      value instanceof SandboxMap ||
      value instanceof SandboxSet ||
      value instanceof SandboxURLSearchParams ||
      value instanceof RegExp ||
      value instanceof Map ||
      value instanceof Set ||
      value instanceof URLSearchParams
    ) {
      return makeInterpreterObject();
    }

    if (seen.has(value)) {
      throw new ToolRuntimeError("InvalidDataValue", `${label} contains a circular value.`);
    }

    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > MAX_GUEST_COLLECTION_ENTRIES) {
        throw new ToolRuntimeError(
          "InvalidDataValue",
          `${label} contains an array of ${value.length} entries, over the CodeMode maximum of ${MAX_GUEST_COLLECTION_ENTRIES}.`,
        );
      }
      budget.charge(0, 0, 0, value.length);
      budget.inspectAccessors(value);
      let present = 0;
      const copied = value.map((item) => {
        present++;
        return copyBounded(item, label, depth + 1, seen, preserveSandboxValues, budget);
      });
      budget.charge(value.length - present);
      seen.delete(value);
      return copied;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${label} must contain plain objects only.`,
        [],
        {
          owner: label,
        },
      );
    }

    budget.inspectAccessors(value);
    const entries = Object.entries(value);
    if (entries.length > MAX_GUEST_COLLECTION_ENTRIES) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        `${label} contains an object with ${entries.length} entries, over the CodeMode maximum of ${MAX_GUEST_COLLECTION_ENTRIES}.`,
      );
    }
    budget.charge(0, 0, 0, entries.length);
    const copied = makeInterpreterObject();
    for (const [key, item] of entries) {
      budget.charge(0, 6 * key.length + 3);
      copied[key] = copyBounded(item, label, depth + 1, seen, preserveSandboxValues, budget);
    }
    seen.delete(value);
    return copied;
  });

export interface SerializableObject {
  [key: string]: SerializableValue;
}
export interface SerializableArray extends Array<SerializableValue> {}
export type SerializableValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | bigint
  | symbol
  | SerializableObject
  | SerializableArray;

/**
 * Copies guest data out of the sandbox with JSON semantics below the top level: object keys
 * holding `undefined` are dropped, and array holes and `undefined` elements become `null`.
 * A top-level `undefined` is returned as is for the caller to interpret.
 */
export const copyOut = (value: InterpreterValue): SerializableValue => {
  const label = "Output value";
  const projected = copyOutBounded(value, 0, new ProjectionBudget(label));
  return expandOut(projected, new ProjectionBudget(label));
};

const expandOut = (
  value: SerializableValue,
  budget: ProjectionBudget<never>,
): SerializableValue => {
  budget.charge(1, 32, value !== null && hasObjectRuntimeType(value) ? 1 : 0);
  if (Array.isArray(value)) {
    budget.charge(0, 0, 0, value.length);
    let present = 0;
    const result = value.map((item) => {
      present++;
      return expandOut(item, budget);
    });
    budget.charge(value.length - present);
    return result;
  }
  if (value !== null && hasObjectRuntimeType(value)) {
    const entries = Object.entries(value);
    budget.charge(0, 0, 0, entries.length);
    return Object.fromEntries(entries.map(([key, item]) => [key, expandOut(item, budget)]));
  }
  return value;
};

const copyOutBounded = (
  value: InterpreterValue,
  depth: number,
  budget: ProjectionBudget<SerializableValue>,
): SerializableValue =>
  budget.project(value, depth, () => {
    if (
      value instanceof SandboxBytes ||
      value instanceof SandboxTextEncoder ||
      value instanceof SandboxTextDecoder
    ) {
      throw new ToolRuntimeError(
        "InvalidDataValue",
        "Opaque byte values cannot cross a data boundary; encode bytes as text first.",
      );
    }
    // Normalize non-finite numbers to null as the value crosses out of the sandbox (final return
    // and tool-call arguments both funnel through here), matching JSON semantics - NaN/Infinity
    // have no JSON representation, so JSON.stringify would produce null anyway.
    if (Predicate.isNumber(value) && !Number.isFinite(value)) {
      return null;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_GUEST_COLLECTION_ENTRIES) {
        throw new ToolRuntimeError(
          "InvalidDataValue",
          "Output array exceeds the collection budget.",
        );
      }
      budget.charge(0, 0, 0, value.length);
      budget.inspectAccessors(value);
      return Array.from(value, (item) => copyOutBounded(item, depth + 1, budget) ?? null);
    }

    if (value instanceof ToolReference) return undefined;
    if (value !== null && hasObjectRuntimeType(value)) {
      budget.inspectAccessors(value);
      const entries = Object.entries(value);
      budget.charge(0, 0, 0, entries.length);
      const copied: Array<[string, SerializableValue]> = [];
      for (const [key, item] of entries) {
        budget.charge(0, 6 * key.length + 3);
        const next = copyOutBounded(item, depth + 1, budget);
        if (next !== undefined) copied.push([key, next]);
      }
      return Object.fromEntries(copied);
    }

    return value;
  });
