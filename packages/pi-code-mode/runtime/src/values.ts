import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type { RuntimeFailure } from "./failure.js";
import { assertBoundedQueryPairs } from "./interpreter/confinement.js";
import type { InterpreterValue } from "./interpreter/model.js";

export class SandboxPromise {
  interrupted = false;
  readonly fiber: Fiber.Fiber<InterpreterValue, RuntimeFailure> | undefined;
  readonly immediate: Effect.Effect<InterpreterValue, RuntimeFailure> | undefined;
  constructor(
    fiber: Fiber.Fiber<InterpreterValue, RuntimeFailure> | undefined,
    immediate?: Effect.Effect<InterpreterValue, RuntimeFailure>,
  ) {
    this.fiber = fiber;
    this.immediate = immediate;
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

export type SandboxValue =
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
  value instanceof SandboxDate ||
  value instanceof SandboxRegExp ||
  value instanceof SandboxMap ||
  value instanceof SandboxSet ||
  value instanceof SandboxURL ||
  value instanceof SandboxURLSearchParams;
