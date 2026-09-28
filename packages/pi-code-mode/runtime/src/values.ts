import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import type { RuntimeFailure } from "./failure.js";
import { assertBoundedCollectionSize, assertBoundedQueryPairs } from "./interpreter/confinement.js";
import * as Predicate from "effect/Predicate";
import {
  type InterpreterObject,
  type InterpreterValue,
  makeInterpreterObject,
} from "./interpreter/model.js";
import { hasObjectRuntimeType } from "./runtime-values.js";

type PromiseExit = Exit.Exit<InterpreterValue, RuntimeFailure>;

/**
 * A guest promise. It settles once, from whichever source finishes first: its work fiber, an
 * earlier logical settlement, or a value known up front. Effect code awaits `outcome()`;
 * listeners registered with `onSettled` run synchronously when it settles, so reactions can be
 * queued without a fiber waiting on every pending promise.
 */
export class SandboxPromise {
  interrupted = false;
  /** The fiber running this promise's work, when it has one; assigned once it is forked. */
  fiber: Fiber.Fiber<InterpreterValue, RuntimeFailure> | undefined = undefined;
  readonly descendants: ReadonlySet<SandboxPromise> | undefined;
  private readonly done = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>();
  private settledExit: PromiseExit | undefined = undefined;
  private listeners: Array<(exit: PromiseExit) => void> = [];

  constructor(descendants?: ReadonlySet<SandboxPromise>) {
    this.descendants = descendants;
  }

  /** A promise already settled with `exit`, as for `Promise.resolve(value)`. */
  static settled(exit: PromiseExit): SandboxPromise {
    const promise = new SandboxPromise();
    promise.settle(exit);
    return promise;
  }

  get exit(): PromiseExit | undefined {
    return this.settledExit;
  }

  /** Settles the promise; the first settlement wins and later ones are ignored. */
  settle(exit: PromiseExit): void {
    if (this.settledExit !== undefined) return;
    this.settledExit = exit;
    Deferred.doneUnsafe(this.done, exit);
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener(exit);
  }

  /** Runs `listener` with the outcome: now if settled, otherwise at settlement. */
  onSettled(listener: (exit: PromiseExit) => void): void {
    if (this.settledExit !== undefined) listener(this.settledExit);
    else this.listeners.push(listener);
  }

  /** The outcome, waiting for it while the promise is pending. */
  outcome(): Effect.Effect<PromiseExit> {
    return this.settledExit !== undefined
      ? Effect.succeed(this.settledExit)
      : Effect.exit(Deferred.await(this.done));
  }
}

export class SandboxDate {
  readonly time: number;
  constructor(time: number) {
    this.time = time;
  }
}

export class SandboxRegExp {
  readonly regex: RegExp;
  constructor(pattern: string, flags: string) {
    this.regex = new RegExp(pattern, flags);
  }
}

export class SandboxMap {
  readonly map = new Map<InterpreterValue, InterpreterValue>();
}

export class SandboxSet {
  readonly set = new Set<InterpreterValue>();
}

export class SandboxURLSearchParams {
  readonly params: URLSearchParams;
  constructor(params: URLSearchParams) {
    this.params = params;
  }
}

export class SandboxURL {
  readonly searchParams: SandboxURLSearchParams;
  readonly url: URL;
  constructor(url: URL) {
    this.url = url;
    // Confinement backstop: charge the parsed query's projected pair count before this
    // eager `searchParams` access materializes the native entry list. The primary guards
    // (with program diagnostics) run at each construction route before the native URL.
    assertBoundedQueryPairs(url.search, "URL query");
    this.searchParams = new SandboxURLSearchParams(url.searchParams);
  }
}

/** Owned storage only; guest member dispatch never exposes this host view. */
export class SandboxBytes {
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    assertBoundedCollectionSize(bytes.length, "Uint8Array");
    this.#bytes = bytes;
  }
  get length(): number {
    return this.#bytes.length;
  }
  storage(): Uint8Array {
    return this.#bytes;
  }
}

export class SandboxTextEncoder {
  readonly #encoding = "utf-8";
  get encoding(): string {
    return this.#encoding;
  }
}

export class SandboxTextDecoder {
  readonly #encoding = "utf-8";
  get encoding(): string {
    return this.#encoding;
  }
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(fatal: boolean, ignoreBOM: boolean) {
    this.fatal = fatal;
    this.ignoreBOM = ignoreBOM;
  }
}

export type SandboxValue =
  | SandboxBytes
  | SandboxTextEncoder
  | SandboxTextDecoder
  | SandboxPromise
  | SandboxDate
  | SandboxRegExp
  | SandboxMap
  | SandboxSet
  | SandboxURL
  | SandboxURLSearchParams;

export const isSandboxValue = <Value>(
  value: Value,
): value is Value & Exclude<SandboxValue, SandboxPromise> =>
  value instanceof SandboxBytes ||
  value instanceof SandboxTextEncoder ||
  value instanceof SandboxTextDecoder ||
  value instanceof SandboxDate ||
  value instanceof SandboxRegExp ||
  value instanceof SandboxMap ||
  value instanceof SandboxSet ||
  value instanceof SandboxURL ||
  value instanceof SandboxURLSearchParams;

const ErrorBrand: unique symbol = Symbol("codemode.error");

/** A guest error: a plain object carrying `name` and `message`, branded as an Error. */
export const createErrorValue = (name: string, message: string): InterpreterObject => {
  const value = Object.assign(makeInterpreterObject(), { name, message });
  Object.defineProperty(value, ErrorBrand, { value: name });
  // Guest code has no host frames to show, so the stack is the error's own first line.
  Object.defineProperty(value, "stack", {
    value: message === "" ? name : `${name}: ${message}`,
    writable: true,
    configurable: true,
  });
  return value;
};

/** The constructor name of a guest error, or undefined for any other value. */
export const errorBrandName = (value: InterpreterValue): string | undefined => {
  if (value === null || !hasObjectRuntimeType(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, ErrorBrand);
  return descriptor && "value" in descriptor && Predicate.isString(descriptor.value)
    ? descriptor.value
    : undefined;
};

/** Whether a value is a guest error created by an Error constructor or a caught failure. */
export const isErrorValue = (value: InterpreterValue): value is InterpreterObject =>
  errorBrandName(value) !== undefined;

/** Keeps `options.cause` of `new Error(message, options)` as a nonenumerable own property. */
export const attachErrorCause = (error: InterpreterObject, options: InterpreterValue): void => {
  if (
    options === null ||
    !hasObjectRuntimeType(options) ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== null ||
    !Object.hasOwn(options, "cause")
  )
    return;
  // SAFETY: A prototype-free guest object is a record of InterpreterValue members.
  const cause = (options as InterpreterObject)["cause"];
  Object.defineProperty(error, "cause", { value: cause, writable: true, configurable: true });
};
