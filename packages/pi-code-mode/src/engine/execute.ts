/**
 * Runs one Code Mode program in a fresh Node process. Pi dispatches the program's tool calls,
 * lets started calls finish when the program ends, and stops early only at the deadline or on
 * interruption, which kill the process group and interrupt calls still in flight.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  openProgramProcess,
  PROGRAM_OUTPUT_BYTES,
  type ProgramProcess,
  type ProgramProcessOptions,
} from "../boundary/host-program-process.ts";
import type { DuplexProcessError } from "pi-cosmic-core";
import type { CodeModeCompletedCall, CodeModeDiagnostic, CodeModeResult } from "./diagnostic.ts";
import { type CallReply, makeDispatcher, type ToolCallHooks } from "./dispatch.ts";
import { childFailureDiagnostic } from "./failure.ts";
import { boundOutput, truncatedValue, utf8ByteLength } from "./output.ts";
import {
  type ChildMessage,
  decodeChildMessage,
  encodeFrame,
  encodeReplyFrame,
  encodeValue,
  makeFrameDecoder,
  MAX_CHILD_FRAME_BYTES,
  MAX_RESULT_BYTES,
  type ParentMessage,
  ProtocolError,
} from "./protocol.ts";
import { assertValidTools, type HostTools } from "./tool-tree.ts";

/** Tool inputs Pi holds at once for calls that are queued or running. */
const MAX_IN_FLIGHT_INPUT_BYTES = 64 * 1024 * 1024;

/** Completed-call output kept for a failed program's result. */
const MAX_COMPLETED_BYTES = 8 * 1024 * 1024;

/** How long Pi waits for the process to exit and its output to close after the result. */
const OUTPUT_TAIL_MS = 250;

export interface ExecutionLimits {
  readonly timeoutMs: number;
  readonly maxToolCalls: number;
  readonly maxOutputBytes: number;
}

export interface ExecuteProgramOptions<R> extends ToolCallHooks<R> {
  readonly code: string;
  /** The session's working directory; the program runs there and resolves imports from it. */
  readonly cwd: string;
  readonly tools: HostTools<R>;
  readonly limits: ExecutionLimits;
  /**
   * Observes the complete result before output bounding. Hosts must bound capture work and
   * must not retain the value; observer errors never change the outcome.
   */
  readonly onResult?: ((result: CodeModeResult) => void) | undefined;
  /** Test seam for the process boundary. */
  readonly openProcess?:
    | ((
        options: ProgramProcessOptions,
      ) => Effect.Effect<ProgramProcess, DuplexProcessError, Scope.Scope>)
    | undefined;
}

type ResultMessage = Extract<ChildMessage, { readonly type: "result" }>;

type Outcome =
  | { readonly _tag: "result"; readonly message: ResultMessage }
  | { readonly _tag: "exited" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "broken"; readonly diagnostic: CodeModeDiagnostic };

const failure = (error: CodeModeDiagnostic): CodeModeResult => ({ ok: false, error });

const executionFailure = (message: string): CodeModeDiagnostic => ({
  kind: "ExecutionFailure",
  message,
});

/** Retained program output: stdout and stderr in arrival order, cut at a fixed size. */
const makeOutput = () => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  return {
    append: (chunk: Uint8Array) => {
      chunks.push(chunk);
      size += chunk.byteLength;
    },
    lines: (): Array<string> => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const cut = size > PROGRAM_OUTPUT_BYTES;
      const text = new TextDecoder().decode(cut ? bytes.subarray(0, PROGRAM_OUTPUT_BYTES) : bytes);
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      if (cut) lines.push(`[output truncated after ${PROGRAM_OUTPUT_BYTES} bytes]`);
      return lines;
    },
  };
};

/** Output of calls that completed, kept for a failed program's result. */
const makeCompleted = () => {
  const calls: Array<CodeModeCompletedCall> = [];
  let size = 0;
  return {
    record: (tool: string, text: string) => {
      if (size >= MAX_COMPLETED_BYTES) return;
      calls.push({ tool: `tools.${tool}`, text });
      size += text.length;
    },
    calls: (): ReadonlyArray<CodeModeCompletedCall> => calls,
  };
};

const successResult = (
  message: Extract<ResultMessage, { readonly ok: true }>,
  maxOutputBytes: number,
): CodeModeResult | undefined => {
  if (message.totalBytes > utf8ByteLength(message.text)) {
    return {
      ok: true,
      value: truncatedValue(message.text, message.totalBytes, maxOutputBytes),
      truncated: true,
    };
  }
  if (message.format === "text") return { ok: true, value: message.text };
  try {
    return { ok: true, value: JSON.parse(message.text) };
  } catch {
    return undefined;
  }
};

export const executeProgram = <R>(
  options: ExecuteProgramOptions<R>,
): Effect.Effect<CodeModeResult, never, R> =>
  Effect.suspend(() => {
    const { limits } = options;
    const finish = (result: CodeModeResult): CodeModeResult => {
      try {
        options.onResult?.(result);
      } catch {
        // Host capture cannot relabel execution.
      }
      return boundOutput(result, limits.maxOutputBytes);
    };
    if (options.code.trim().length === 0) {
      return Effect.succeed(
        finish(failure({ kind: "ParseError", message: "Code cannot be empty." })),
      );
    }
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return Effect.succeed(
        finish(failure(executionFailure("Code Mode requires macOS or Linux."))),
      );
    }
    assertValidTools(options.tools);
    let cleanupConfirmed = true;
    const openProcess = options.openProcess ?? openProgramProcess;

    const run = Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + limits.timeoutMs;
      const output = makeOutput();
      const completed = makeCompleted();
      const callFailures = new Map<number, CodeModeDiagnostic>();
      const dispatcher = makeDispatcher({
        tools: options.tools,
        maxToolCalls: limits.maxToolCalls,
        hooks: {
          onToolCallLifecycle: options.onToolCallLifecycle,
          onToolCallStart: options.onToolCallStart,
        },
      });
      const withDetails = (result: CodeModeResult): CodeModeResult => {
        const logs = output.lines();
        const calls = completed.calls();
        return {
          ...result,
          ...(logs.length > 0 && { logs }),
          ...(!result.ok && calls.length > 0 && { completed: calls }),
        };
      };

      const opened = yield* Effect.result(
        openProcess({
          cwd: options.cwd,
          writeTimeoutMs: limits.timeoutMs + 5_000,
          onCleanup: (confirmed) => {
            cleanupConfirmed = confirmed;
          },
        }),
      );
      if (opened._tag === "Failure") {
        return failure(executionFailure("Code Mode could not start a Node.js process."));
      }
      const child = opened.success;
      const fibers = yield* FiberSet.make<void, never>();
      const outputReader = yield* child.stderr.pipe(
        Stream.runForEach((chunk) => Effect.sync(() => output.append(chunk))),
        Effect.forkScoped,
      );
      const write = (message: ParentMessage) => child.write(encodeFrame(message));

      const deliver =
        (seq: number) =>
        (reply: CallReply): Effect.Effect<CodeModeDiagnostic | undefined> =>
          Effect.gen(function* () {
            if (!reply.ok) {
              callFailures.set(seq, reply.error);
              yield* Effect.ignore(
                write({
                  type: "reply",
                  seq,
                  ok: false,
                  kind: reply.error.kind,
                  message: reply.error.message,
                }),
              );
              return reply.error;
            }
            const valueText = encodeValue(reply.value);
            if (valueText === undefined) {
              const error: CodeModeDiagnostic = {
                kind: "InvalidToolOutput",
                message: `Invalid output from tool '${reply.name}': the result is not JSON data. The tool ran, but its result was not returned to the program.`,
                facts: { tool: reply.name },
              };
              callFailures.set(seq, error);
              yield* Effect.ignore(
                write({ type: "reply", seq, ok: false, kind: error.kind, message: error.message }),
              );
              return error;
            }
            const written = yield* Effect.result(child.write(encodeReplyFrame(seq, valueText)));
            if (written._tag === "Failure") {
              return executionFailure("The program ended before this result was delivered.");
            }
            completed.record(reply.name, Predicate.isString(reply.value) ? reply.value : valueText);
            return undefined;
          });

      let inFlightBytes = 0;
      const decoder = makeFrameDecoder(MAX_CHILD_FRAME_BYTES);
      const receive = (frame: Uint8Array) =>
        Effect.gen(function* () {
          const message = yield* decodeChildMessage(frame);
          if (message.type !== "call") return Option.some(message);
          inFlightBytes += frame.byteLength;
          if (inFlightBytes > MAX_IN_FLIGHT_INPUT_BYTES) {
            return yield* new ProtocolError({ reason: "in-flight" });
          }
          yield* FiberSet.run(
            fibers,
            dispatcher.call(message.path, message.args, deliver(message.seq)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  inFlightBytes -= frame.byteLength;
                }),
              ),
            ),
          );
          return Option.none<ResultMessage>();
        });

      const awaitResult: Effect.Effect<Outcome, never, R> = child.stdout.pipe(
        Stream.mapEffect((chunk) =>
          Effect.try({
            try: () => decoder(chunk),
            catch: (error) =>
              error instanceof ProtocolError ? error : new ProtocolError({ reason: "malformed" }),
          }),
        ),
        Stream.flattenIterable,
        Stream.mapEffect(receive),
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.map(Option.flatten),
        Effect.map(
          (message): Outcome =>
            Option.isSome(message)
              ? { _tag: "result", message: message.value }
              : { _tag: "exited" },
        ),
        Effect.catch((error) =>
          Effect.succeed<Outcome>({
            _tag: "broken",
            diagnostic: !(error instanceof ProtocolError)
              ? executionFailure("Code Mode lost its connection to the program's process.")
              : error.reason === "in-flight"
                ? executionFailure(
                    "The program sent more tool input at once than Code Mode holds (64 MiB across queued and running calls).",
                  )
                : error.reason === "oversize"
                  ? executionFailure(
                      "The program's process sent a message larger than Code Mode accepts.",
                    )
                  : executionFailure("The program's process sent an invalid Code Mode message."),
          }),
        ),
        // The child sends its result only after every reply settled; join the dispatch fibers.
        Effect.tap(() => FiberSet.awaitEmpty(fibers)),
      );

      const started = yield* Effect.result(
        write({
          type: "start",
          source: options.code,
          tools: dispatcher.paths,
          resultLimit: MAX_RESULT_BYTES,
        }),
      );
      const outcome: Outcome =
        started._tag === "Failure"
          ? {
              _tag: "broken",
              diagnostic: executionFailure("Code Mode could not start the program."),
            }
          : yield* awaitResult.pipe(
              Effect.timeoutOrElse({
                duration: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
                orElse: () => Effect.succeed<Outcome>({ _tag: "timeout" }),
              }),
            );

      if (outcome._tag === "timeout") {
        return withDetails(
          failure({
            kind: "TimeoutExceeded",
            message: `Execution timed out after ${limits.timeoutMs}ms.`,
            facts: { timeoutMs: limits.timeoutMs },
          }),
        );
      }
      // A broken connection gets no grace: the scope kills the process and keeps what arrived.
      if (outcome._tag === "broken") return withDetails(failure(outcome.diagnostic));
      // Let the process exit on its own so its last output arrives, then sweep its group.
      if (outcome._tag === "result") yield* Effect.ignore(write({ type: "finish" }));
      const exit = yield* child.exit.pipe(Effect.timeoutOption(OUTPUT_TAIL_MS));
      yield* Fiber.await(outputReader).pipe(Effect.timeoutOption(OUTPUT_TAIL_MS));

      if (outcome._tag === "exited") {
        const status = Option.match(exit, {
          onNone: () => "",
          onSome: ({ code, signal }) =>
            code !== null ? ` (exit code ${code})` : signal !== null ? ` (signal ${signal})` : "",
        });
        return withDetails(
          failure(executionFailure(`The program exited before returning a result${status}.`)),
        );
      }
      const { message } = outcome;
      if (!message.ok) {
        return withDetails(
          failure(childFailureDiagnostic(message.failure, options.tools, callFailures)),
        );
      }
      const success = successResult(message, limits.maxOutputBytes);
      return withDetails(
        success ?? failure(executionFailure("The program's process sent an invalid result.")),
      );
    });

    return Effect.scoped(run).pipe(
      Effect.map((result) =>
        cleanupConfirmed
          ? result
          : {
              ...result,
              logs: [
                ...(result.logs ?? []),
                "[Code Mode could not confirm that every process the program started has stopped.]",
              ],
            },
      ),
      Effect.map(finish),
    );
  });
