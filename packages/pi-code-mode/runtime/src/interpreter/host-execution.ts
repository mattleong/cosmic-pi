import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { DataValue, ExecuteOptions, ResolvedExecutionLimits, Result } from "../codemode.js";
import {
  copyIn,
  copyOut,
  type HostTools,
  type Services,
  type ToolCallHooks,
  ToolRuntime,
} from "../tool-runtime.js";
import { ExecutionDeadline } from "./confinement.js";
import { normalizeError, parseProgram } from "./diagnostics.js";
import { Interpreter } from "./runtime.js";

/**
 * Executes one Effect-native CodeMode program without constructing a reusable runtime.
 *
 * @example
 * ```ts
 * export const result = yield* CodeMode.execute({
 *   tools: { lookup },
 *   code: `return await tools.lookup({ id: "order_42" })`,
 * })
 * ```
 */
export const executeWithLimits = <const Tools extends object>(
  options: ExecuteOptions<Tools>,
  limits: ResolvedExecutionLimits,
  searchIndex: ToolRuntime.DiscoveryPlan["searchIndex"],
): Effect.Effect<Result, never, Services<Tools>> => {
  let hooks: ToolCallHooks<Services<Tools>> = {};
  if (options.onToolCallLifecycle !== undefined)
    hooks = { ...hooks, onToolCallLifecycle: options.onToolCallLifecycle };
  if (options.onToolCallStart !== undefined)
    hooks = { ...hooks, onToolCallStart: options.onToolCallStart };
  if (options.onToolCallEnd !== undefined)
    hooks = { ...hooks, onToolCallEnd: options.onToolCallEnd };
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  const tools = ToolRuntime.make(
    (options.tools ?? {}) as HostTools<Services<Tools>>,
    limits.maxToolCalls,
    searchIndex,
    hooks,
  );
  const logs: Array<string> = [];
  const logged = () => (logs.length > 0 ? { logs: [...logs] } : {});
  const observe = (result: Result): Result => {
    try {
      options.onResult?.(result);
    } catch {
      /* Host capture cannot relabel execution. */
    }
    return result;
  };

  if (options.code.trim().length === 0) {
    return Effect.succeed({
      ok: false,
      error: { kind: "ParseError", message: "Code cannot be empty." },
      toolCalls: tools.calls,
    } satisfies Result).pipe(Effect.map(observe));
  }

  // Confinement: the wall-clock deadline is shared with the interpreter so synchronous
  // native overruns are normalized to TimeoutExceeded even while the Effect timer is starved.
  const deadline = new ExecutionDeadline(limits.timeoutMs);
  const operation = Effect.gen(function* () {
    const program = parseProgram(options.code);
    const interpreter = new Interpreter<Services<Tools>>(
      tools.invoke,
      tools.keys,
      logs,
      deadline,
      options.onToolCallLifecycle,
    );
    const value = yield* interpreter.run(program);
    // A program whose final synchronous operation ran past the deadline must not race the
    // (event-loop-starved) Effect timer into an ok result.
    deadline.check();
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const result = copyOut(copyIn(value, "Execution result"), true) as DataValue;
    deadline.check();
    return {
      ok: true,
      value: result,
      ...logged(),
      toolCalls: tools.calls,
    } satisfies Result;
  }).pipe((program) => {
    const timeoutMs = limits.timeoutMs;
    if (timeoutMs === undefined) return program;
    return program.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.succeed({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: `Execution timed out after ${timeoutMs}ms.`,
            },
            ...logged(),
            toolCalls: tools.calls,
          } satisfies Result),
      }),
    );
  });

  return operation.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed({
            ok: false,
            error: normalizeError(Cause.squash(cause)),
            ...logged(),
            toolCalls: tools.calls,
          } satisfies Result),
    ),
    Effect.map((result) => {
      try {
        const bounded =
          limits.maxOutputBytes === undefined ? result : boundOutput(result, limits.maxOutputBytes);
        // Serialization is synchronous too. Never publish success after a late projection.
        if (result.ok) deadline.check();
        observe(result);
        return bounded;
      } catch (error) {
        const failure = observe({
          ok: false,
          error: normalizeError(error),
          ...logged(),
          toolCalls: tools.calls,
        });
        return limits.maxOutputBytes === undefined
          ? failure
          : boundOutput(failure, limits.maxOutputBytes);
      }
    }),
  );
};

export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

// Cut before a partial UTF-8 sequence without discarding genuine replacement characters.
export const utf8Truncate = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
};

/**
 * Bounds the model-facing output content (serialized result value or diagnostic message,
 * plus logs) to `maxOutputBytes`. Truncation markers are reserved *inside* the budget, so
 * value bytes + diagnostic-message bytes + log bytes (markers included) never exceed
 * `maxOutputBytes`. Oversized values are replaced by their truncated serialized text with an
 * explanatory marker, oversized diagnostic messages are truncated code-point-safely, and
 * logs are kept from the start until the remaining budget is exhausted. Truncation never
 * fails the execution; `truncated: true` marks affected results. Only runs when the host set
 * `maxOutputBytes` - with the limit absent, output passes through unbounded.
 */
export const boundOutput = (result: Result, maxOutputBytes: number): Result => {
  let truncated = false;

  let value: DataValue = null;
  let error = result.ok ? undefined : result.error;
  let usedBytes = 0;
  if (result.ok) {
    const serialized = JSON.stringify(result.value) ?? "null";
    const bytes = utf8ByteLength(serialized);
    if (bytes > maxOutputBytes) {
      truncated = true;
      const marker = ` [result truncated: ${bytes} bytes exceeds the ${maxOutputBytes}-byte output limit; return a smaller value]`;
      const markerBytes = utf8ByteLength(marker);
      value =
        markerBytes >= maxOutputBytes
          ? utf8Truncate(serialized, maxOutputBytes)
          : `${utf8Truncate(serialized, maxOutputBytes - markerBytes)}${marker}`;
      usedBytes = utf8ByteLength(value);
    } else {
      value = result.value;
      usedBytes = bytes;
    }
  } else if (error !== undefined) {
    // A hostile program can throw arbitrarily large strings; the diagnostic message is part
    // of the model-facing output and is bounded inside the same budget.
    const messageBytes = utf8ByteLength(error.message);
    if (messageBytes > maxOutputBytes) {
      truncated = true;
      error = { ...error, message: utf8Truncate(error.message, maxOutputBytes) };
    }
    usedBytes = utf8ByteLength(error.message);
  }

  const logs = result.logs ?? [];
  const kept: Array<string> = [];
  const logBudget = Math.max(0, maxOutputBytes - usedBytes);
  let logBytes = 0;
  for (const line of logs) {
    const lineBytes = utf8ByteLength(line) + 1;
    if (logBytes + lineBytes > logBudget) break;
    logBytes += lineBytes;
    kept.push(line);
  }
  if (kept.length < logs.length) {
    truncated = true;
    // The truncation marker is budgeted like any other line: drop kept lines until it fits,
    // and omit it entirely when even the bare marker cannot fit.
    for (;;) {
      const marker = `[logs truncated: showing ${kept.length} of ${logs.length} lines]`;
      const markerBytes = utf8ByteLength(marker) + 1;
      if (logBytes + markerBytes <= logBudget) {
        kept.push(marker);
        break;
      }
      const dropped = kept.pop();
      if (dropped === undefined) break;
      logBytes -= utf8ByteLength(dropped) + 1;
    }
  }

  if (!truncated) return result;
  const logsPart = kept.length > 0 ? { logs: kept } : {};
  return result.ok
    ? { ok: true, value, ...logsPart, truncated: true, toolCalls: result.toolCalls }
    : {
        ok: false,
        error: error!,
        ...logsPart,
        truncated: true,
        toolCalls: result.toolCalls,
      };
};
