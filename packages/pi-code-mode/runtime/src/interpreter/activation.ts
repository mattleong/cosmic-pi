import type * as Deferred from "effect/Deferred";
import type * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { RuntimeFailure } from "../failure.js";
import { TOOL_CALL_CONCURRENCY } from "../stdlib/promise.js";
import { errorConstructors } from "../stdlib/value.js";
import type { ToolRuntime } from "../tool-runtime.js";
import type { ToolPathKind } from "../tool-tree.js";
import type { SandboxPromise } from "../values.js";
import { ExecutionDeadline } from "./deadline.js";
import { GuestTurns } from "./guest-turns.js";
import {
  type Binding,
  CoercionFunction,
  ErrorConstructorReference,
  GlobalMethodReference,
  GlobalNamespace,
  type InterpreterValue,
  PromiseNamespace,
  ToolReference,
  UriFunction,
} from "./model.js";
import { RecursionBudget } from "./recursion.js";

export type PromiseOwners = ReadonlyArray<Set<SandboxPromise>>;

/** State one execution owns, shared by every guest activation it runs. */
export interface ExecutionContext<R> {
  readonly admitTool: ToolRuntime.AdmitTool<R>;
  readonly onToolCallLifecycle:
    | ((event: ToolRuntime.ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  /** Enumerable names at a node of the host tool tree; the interpreter never holds the tree. */
  readonly toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
  /** Whether a tool path names a tool, a namespace, or nothing. */
  readonly toolKind: (path: ReadonlyArray<string>) => ToolPathKind;
  readonly logs: Array<string>;
  /**
   * Shared wall-clock deadline, checked between interpreter steps so an overrun inside a
   * synchronous native operation becomes TimeoutExceeded as soon as control returns.
   */
  readonly deadline: ExecutionDeadline;
  readonly recursion: RecursionBudget;
  /** Caps how many eagerly started tool calls run at once. */
  readonly callPermits: Semaphore.Semaphore;
  /**
   * Fiber-backed promises no program construct has observed yet. Completion drains them and
   * reports a never-awaited failure as an unhandled rejection.
   */
  readonly pendingSettlements: Set<SandboxPromise>;
  readonly scope: Scope.Closeable;
  /** FIFO guest turns: one synchronous guest turn runs at a time. */
  readonly turns: GuestTurns;
  readonly interrupting: Set<SandboxPromise>;
  nextToolCallLifecycleId: number;
  activePromises: number;
}

/** One guest activation: the scope chain, turn, and suspension state of a running call. */
export interface Activation<R> {
  readonly execution: ExecutionContext<R>;
  scopes: Array<Map<string, Binding>>;
  functionScope: Map<string, Binding> | undefined;
  callDepth: number;
  owners: PromiseOwners;
  turn: { held: boolean };
  firstBoundary: Deferred.Deferred<void> | undefined;
  lastValue: InterpreterValue;
  generatorAsync: boolean;
  generatorYield:
    | ((value: InterpreterValue) => Effect.Effect<InterpreterValue, RuntimeFailure, R>)
    | undefined;
}

export interface ExecutionOptions<R> {
  readonly admitTool: ToolRuntime.AdmitTool<R>;
  readonly toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
  readonly toolKind?: (path: ReadonlyArray<string>) => ToolPathKind;
  readonly logs?: Array<string>;
  readonly deadline?: ExecutionDeadline;
  readonly onToolCallLifecycle?: (
    event: ToolRuntime.ToolCallLifecycleEvent,
  ) => Effect.Effect<void, never, R>;
  /** Internal tests inject a smaller budget; production always uses the default. */
  readonly recursion?: RecursionBudget;
}

/** A fresh execution with its root activation, whose global scope holds the built-ins. */
export const makeRootActivation = <R>(options: ExecutionOptions<R>): Activation<R> => {
  const execution: ExecutionContext<R> = {
    admitTool: options.admitTool,
    onToolCallLifecycle: options.onToolCallLifecycle,
    toolKeys: options.toolKeys,
    toolKind: options.toolKind ?? ((path) => (path.length === 0 ? "namespace" : undefined)),
    logs: options.logs ?? [],
    deadline: options.deadline ?? new ExecutionDeadline(undefined),
    recursion: options.recursion ?? new RecursionBudget(),
    callPermits: Semaphore.makeUnsafe(TOOL_CALL_CONCURRENCY),
    pendingSettlements: new Set(),
    // Teardown interrupts every live call at once, so a timeout is not delayed by the sum of
    // each call's cleanup.
    scope: Scope.makeUnsafe("parallel"),
    turns: new GuestTurns(),
    interrupting: new Set(),
    nextToolCallLifecycleId: 0,
    activePromises: 0,
  };
  return {
    execution,
    scopes: [globalScope()],
    functionScope: undefined,
    callDepth: 0,
    owners: [],
    turn: { held: false },
    firstBoundary: undefined,
    lastValue: undefined,
    generatorAsync: false,
    generatorYield: undefined,
  };
};

/** A child activation: the caller's scope chain, depth, turn, and promise owners. */
export const forkActivation = <R>(parent: Activation<R>): Activation<R> => ({
  execution: parent.execution,
  scopes: parent.scopes.slice(),
  functionScope: undefined,
  callDepth: parent.callDepth,
  owners: parent.owners,
  turn: parent.turn,
  firstBoundary: undefined,
  lastValue: undefined,
  generatorAsync: false,
  generatorYield: undefined,
});

const globalScope = (): Map<string, Binding> => {
  const scope = new Map<string, Binding>();
  const define = (name: string, value: InterpreterValue) =>
    scope.set(name, { mutable: false, value });
  define("tools", new ToolReference([]));
  for (const name of [
    "Symbol",
    "Uint8Array",
    "TextEncoder",
    "TextDecoder",
    "Object",
    "Math",
    "JSON",
    "Array",
    "console",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "URL",
    "URLSearchParams",
  ] as const)
    define(name, new GlobalNamespace(name));
  define("atob", new GlobalMethodReference("Encoding", "atob"));
  define("btoa", new GlobalMethodReference("Encoding", "btoa"));
  define("Promise", new PromiseNamespace());
  define("undefined", undefined);
  for (const name of [
    "Number",
    "String",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
  ] as const)
    define(name, new CoercionFunction(name));
  for (const name of [
    "encodeURI",
    "encodeURIComponent",
    "decodeURI",
    "decodeURIComponent",
  ] as const)
    define(name, new UriFunction(name));
  // Error constructors are real values, so `x instanceof Error` works and `Error("msg")`
  // (with or without `new`) constructs a branded { name, message } error object.
  for (const name of errorConstructors) define(name, new ErrorConstructorReference(name));
  // NaN/Infinity flow as ordinary in-sandbox values (normalized to null only at the data
  // boundary), so their global bindings must exist too, e.g. `reduce(max, -Infinity)`.
  define("NaN", NaN);
  define("Infinity", Infinity);
  return scope;
};
