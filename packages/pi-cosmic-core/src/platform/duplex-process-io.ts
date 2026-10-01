import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { DuplexProcessChild } from "./node-builtins.ts";

type Readable = DuplexProcessChild["stdout"];
type Writable = DuplexProcessChild["stdin"];
import { invokeHostCallback } from "../host-session.ts";
import { duplexProcessError, type DuplexProcessError } from "./duplex-process-close.ts";

const MAX_QUEUE_CHUNK_BYTES = 64 * 1024;

interface WriteItem {
  bytes: Uint8Array | undefined;
  readonly done: Deferred.Deferred<void, DuplexProcessError>;
  active: boolean;
  settled: boolean;
}

export interface DuplexProcessIoOptions {
  readonly maxReadQueueBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStderrQueueBytes: number;
  readonly maxWriteBytes: number;
  readonly maxWriteQueueBytes: number;
  readonly writeTimeoutMs: number;
  readonly onProcessFailure: (error: DuplexProcessError) => void;
}

/** The native streams one IO owner reads and writes. */
export interface DuplexProcessStreams {
  /** Writable end of the duplex channel. */
  readonly input: Writable;
  /** Readable end of the duplex channel. */
  readonly output: Readable;
  /** Retained diagnostic output; chunks from every stream share one queue in arrival order. */
  readonly diagnostics: ReadonlyArray<Readable>;
}

export interface DuplexProcessIo {
  readonly stdout: Stream.Stream<Uint8Array, DuplexProcessError>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, DuplexProcessError>;
  readonly processExit: () => void;
  readonly fail: (error: DuplexProcessError) => void;
  /** Revoke input and join the writer before native termination. */
  readonly stop: Effect.Effect<void>;
  /** Release stream ingress after native termination has been requested. */
  readonly close: Effect.Effect<void>;
}

const closedError = (): DuplexProcessError =>
  duplexProcessError("write", "closed", "Child process input is closed.");
const writeFailure = (): DuplexProcessError =>
  duplexProcessError("write", "failed", "Unable to write to child process input.");
const overflowError = (): DuplexProcessError =>
  duplexProcessError("write", "overflow", "Child process input queue exceeded its byte limit.");

/** One scope owns native ingress, a byte budget, and exactly one channel writer. */
export const makeDuplexProcessIo = (
  streams: DuplexProcessStreams,
  options: DuplexProcessIoOptions,
): Effect.Effect<DuplexProcessIo, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { input, output, diagnostics } = streams;
    // Count capacity cannot reject a byte-admissible sequence of tiny chunks.
    const stdoutQueue = yield* Queue.bounded<Uint8Array, DuplexProcessError | Cause.Done>(
      options.maxReadQueueBytes,
    );
    const stderrQueue = yield* Queue.bounded<Uint8Array, Cause.Done>(
      Math.max(1, options.maxStderrQueueBytes),
    );
    const writeQueue = yield* Queue.bounded<WriteItem, Cause.Done>(options.maxWriteQueueBytes);
    const pendingWrites = new Set<WriteItem>();
    let queuedStdoutBytes = 0;
    let queuedStderrBytes = 0;
    let retainedStderrBytes = 0;
    let pendingWriteBytes = 0;
    let closed = false;
    let processExited = false;
    let stdoutFailed = false;
    let inputFailure: DuplexProcessError | undefined;
    let writer: Fiber.Fiber<void> | undefined;

    const settleWrite = (item: WriteItem, error?: DuplexProcessError): void => {
      if (item.settled) return;
      item.settled = true;
      Deferred.doneUnsafe(item.done, error ? Effect.fail(error) : Effect.void);
    };
    const releaseWrite = (item: WriteItem): void => {
      if (!item.bytes) return;
      pendingWriteBytes -= item.bytes.byteLength;
      item.bytes = undefined;
      pendingWrites.delete(item);
    };
    const failPendingWrites = (error: DuplexProcessError): void => {
      for (const item of pendingWrites) {
        settleWrite(item, error);
        // Cancellation/exit does not release a buffer still held by Node.
        if (!item.active) releaseWrite(item);
      }
    };
    const failInput = (error: DuplexProcessError): void => {
      if (inputFailure || closed) return;
      inputFailure = error;
      failPendingWrites(error);
      invokeHostCallback(() => options.onProcessFailure(error), undefined);
    };
    const failStdout = (error: DuplexProcessError): void => {
      if (stdoutFailed || closed) return;
      stdoutFailed = true;
      Queue.failCauseUnsafe(stdoutQueue, Cause.fail(error));
      failInput(error);
    };
    const onStdoutData = (chunk: Uint8Array | string): void => {
      if (closed || stdoutFailed) return;
      const bytes = Predicate.isString(chunk) ? Buffer.from(chunk) : chunk;
      if (queuedStdoutBytes + bytes.byteLength > options.maxReadQueueBytes) {
        failStdout(
          duplexProcessError("read", "overflow", "Child process output exceeded its byte limit."),
        );
        return;
      }
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_QUEUE_CHUNK_BYTES) {
        const part = Uint8Array.from(bytes.subarray(offset, offset + MAX_QUEUE_CHUNK_BYTES));
        queuedStdoutBytes += part.byteLength;
        Queue.offerUnsafe(stdoutQueue, part);
      }
    };
    const onStdoutError = (): void =>
      failStdout(duplexProcessError("read", "failed", "Unable to read child process output."));
    const onStdoutEnd = (): void => {
      Queue.endUnsafe(stdoutQueue);
    };
    const onStderrData = (chunk: Uint8Array | string): void => {
      if (closed) return;
      const bytes = Predicate.isString(chunk) ? Buffer.from(chunk) : chunk;
      const remaining = Math.min(
        options.maxStderrBytes - retainedStderrBytes,
        options.maxStderrQueueBytes - queuedStderrBytes,
      );
      if (remaining <= 0 || bytes.byteLength === 0) return;
      const retained = Uint8Array.from(bytes.subarray(0, remaining));
      queuedStderrBytes += retained.byteLength;
      retainedStderrBytes += retained.byteLength;
      Queue.offerUnsafe(stderrQueue, retained);
    };
    // The diagnostic queue ends once every diagnostic stream has ended, errored or closed.
    const endedDiagnostics = new Set<Readable>();
    const diagnosticEnd = (stream: Readable) => (): void => {
      endedDiagnostics.add(stream);
      if (endedDiagnostics.size === diagnostics.length) Queue.endUnsafe(stderrQueue);
    };
    const diagnosticListeners = diagnostics.map((stream) => {
      const end = diagnosticEnd(stream);
      const close = (): void => {
        end();
        stream.off("error", end);
      };
      return { stream, end, close };
    });
    const onStdinError = (): void => failInput(writeFailure());
    const onStdinClose = (): void => {
      failPendingWrites(closedError());
      for (const item of pendingWrites) releaseWrite(item);
      input.off("error", onStdinError);
    };
    const onStdoutClose = (): void => {
      onStdoutEnd();
      output.off("error", onStdoutError);
    };

    output.on("data", onStdoutData);
    output.on("error", onStdoutError);
    output.once("end", onStdoutEnd);
    output.once("close", onStdoutClose);
    for (const { stream, end, close } of diagnosticListeners) {
      stream.on("data", onStderrData);
      stream.on("error", end);
      stream.once("end", end);
      stream.once("close", close);
    }
    if (diagnostics.length === 0) Queue.endUnsafe(stderrQueue);
    input.on("error", onStdinError);
    input.once("close", onStdinClose);

    const nativeWrite = (item: WriteItem): Effect.Effect<void, DuplexProcessError> =>
      Effect.callback<void, DuplexProcessError>((resume) => {
        const bytes = item.bytes;
        if (!bytes || closed || processExited || inputFailure || input.destroyed) {
          releaseWrite(item);
          resume(Effect.fail(inputFailure ?? closedError()));
          return;
        }
        item.active = true;
        try {
          input.write(bytes, (error) => {
            // A write callback, unlike write()'s boolean, confirms native release.
            releaseWrite(item);
            resume(error ? Effect.fail(writeFailure()) : Effect.void);
          });
        } catch {
          releaseWrite(item);
          resume(Effect.fail(writeFailure()));
        }
        // The native callback remains responsible for release if this wait times out.
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.writeTimeoutMs,
          orElse: () =>
            Effect.fail(
              duplexProcessError(
                "write",
                "timeout",
                "Child process input did not accept data before its deadline.",
              ),
            ),
        }),
      );
    const writeLoop = Effect.forever(
      Queue.take(writeQueue).pipe(
        Effect.flatMap((item) =>
          item.bytes === undefined
            ? Effect.void
            : nativeWrite(item).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.sync(() => {
                      settleWrite(item, error);
                      failInput(error);
                    }),
                  onSuccess: () => Effect.sync(() => settleWrite(item)),
                }),
              ),
        ),
      ),
    ).pipe(Effect.ignore);

    const stop = Effect.uninterruptible(
      Effect.gen(function* () {
        closed = true;
        failPendingWrites(closedError());
        yield* Queue.shutdown(writeQueue);
        if (writer) yield* Fiber.interrupt(writer);
      }),
    );
    const close = stop.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          yield* Queue.shutdown(stdoutQueue);
          yield* Queue.shutdown(stderrQueue);
          output.off("data", onStdoutData);
          output.off("end", onStdoutEnd);
          for (const { stream, end } of diagnosticListeners) {
            stream.off("data", onStderrData);
            stream.off("end", end);
          }
          // Error listeners stay until each native stream's close, including late EPIPE.
          if (input.closed) onStdinClose();
          if (output.closed) onStdoutClose();
          for (const { stream, close } of diagnosticListeners) if (stream.closed) close();
          queuedStdoutBytes = 0;
          queuedStderrBytes = 0;
        }),
      ),
    );
    yield* Effect.addFinalizer(() => close);
    writer = yield* writeLoop.pipe(Effect.forkScoped({ uninterruptible: false }));

    const write = (bytes: Uint8Array): Effect.Effect<void, DuplexProcessError> =>
      Effect.suspend(() => {
        if (closed || processExited) return Effect.fail(closedError());
        if (inputFailure) return Effect.fail(inputFailure);
        if (
          bytes.byteLength > options.maxWriteBytes ||
          pendingWriteBytes + bytes.byteLength > options.maxWriteQueueBytes
        ) {
          return Effect.fail(overflowError());
        }
        if (bytes.byteLength === 0) return Effect.void;
        const item: WriteItem = {
          bytes: Uint8Array.from(bytes),
          done: Deferred.makeUnsafe<void, DuplexProcessError>(),
          active: false,
          settled: false,
        };
        pendingWrites.add(item);
        pendingWriteBytes += bytes.byteLength;
        if (!Queue.offerUnsafe(writeQueue, item)) {
          releaseWrite(item);
          return Effect.fail(overflowError());
        }
        return Deferred.await(item.done).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              settleWrite(item, closedError());
              if (!item.active) releaseWrite(item);
            }),
          ),
        );
      });
    const processExit = (): void => {
      processExited = true;
      failPendingWrites(closedError());
      // Exit is not stdout/stderr EOF: descendants can still own the pipes.
    };
    const stdout = Stream.fromQueue(stdoutQueue).pipe(
      Stream.mapEffect((chunk) =>
        Effect.sync(() => {
          queuedStdoutBytes -= chunk.byteLength;
          return chunk;
        }),
      ),
    );
    const stderr = Stream.fromQueue(stderrQueue).pipe(
      Stream.mapEffect((chunk) =>
        Effect.sync(() => {
          queuedStderrBytes -= chunk.byteLength;
          return chunk;
        }),
      ),
    );
    return { stdout, stderr, write, processExit, fail: failStdout, stop, close };
  });
