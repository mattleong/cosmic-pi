import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { DuplexProcessError, DuplexProcessHandle } from "pi-cosmic-core";

const WRITE_QUEUE_CAPACITY = 64;

export type SdkStdioTransportErrorKind =
  | "not-started"
  | "closed"
  | "cancelled"
  | "read"
  | "write"
  | "input-limit"
  | "output-limit";

/** Native transport failures contain no child output or SDK diagnostics. */
export class SdkStdioTransportError extends Schema.TaggedError<SdkStdioTransportError>()(
  "SdkStdioTransportError",
  {
    kind: Schema.Literals([
      "not-started",
      "closed",
      "cancelled",
      "read",
      "write",
      "input-limit",
      "output-limit",
    ]),
    message: Schema.String,
  },
) {
  static of(kind: SdkStdioTransportErrorKind): SdkStdioTransportError {
    return new SdkStdioTransportError({ kind, message: `MCP stdio transport failed (${kind}).` });
  }
}

// SAFETY: All supported Node engines have this ES2024 API; the workspace
// targets ES2022. This supplies its missing declaration at the SDK Promise seam.
const NativePromise = Promise as PromiseConstructor & {
  withResolvers<A>(): {
    promise: Promise<A>;
    resolve: (value: A | PromiseLike<A>) => void;
    reject: (error: Error) => void;
  };
};

interface PendingWrite {
  bytes: Uint8Array | undefined;
  readonly requestId: RequestId | undefined;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly removeListener: () => void;
  readonly cancelled: Deferred.Deferred<void>;
  dispatched: boolean;
}

export interface SdkStdioTransportOptions {
  readonly maxBufferSize: number;
  readonly maxWriteBytes: number;
}

export interface SdkStdioTransport extends Transport {
  /** Preserve a fatal transport failure when the SDK rejects requests on close. */
  readonly failure: SdkStdioTransportError | undefined;
}

const genericReadError = (error: DuplexProcessError): SdkStdioTransportError =>
  SdkStdioTransportError.of(error.reason === "overflow" ? "output-limit" : "read");

/** Public SDK framing/correlation over one Effect-owned reader/writer scope. */
export const makeSdkStdioTransport = (
  process: DuplexProcessHandle,
  options: SdkStdioTransportOptions,
): Effect.Effect<SdkStdioTransport, never, import("effect/Scope").Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const writeQueue = yield* Queue.bounded<PendingWrite, Cause.Done>(WRITE_QUEUE_CAPACITY);
      const start = yield* Deferred.make<void>();
      const stop = yield* Deferred.make<void>();
      const completion = NativePromise.withResolvers<void>();
      // The SDK may not call close after a read failure. Keep rejection handled
      // while retaining the same rejected Promise for an explicit close caller.
      void completion.promise.catch(() => {});
      let started = false;
      let closed = false;
      let closeNotified = false;
      let failure: SdkStdioTransportError | undefined;
      let onclose: Transport["onclose"];
      let onerror: Transport["onerror"];
      let onmessage: Transport["onmessage"];
      let queuedBytes = 0;
      const pending = new Set<PendingWrite>();
      const readBuffer = new ReadBuffer({ maxBufferSize: options.maxBufferSize });

      const notifyClose = (): void => {
        if (closeNotified || onclose === undefined) return;
        closeNotified = true;
        try {
          onclose();
        } catch {
          // Foreign callbacks cannot prevent scope cleanup.
        }
      };
      const settle = (item: PendingWrite, error?: Error): void => {
        if (!pending.delete(item)) return;
        queuedBytes -= item.bytes?.byteLength ?? 0;
        item.bytes = undefined;
        item.removeListener();
        if (error === undefined) item.resolve();
        else item.reject(error);
      };
      const cancel = (item: PendingWrite): void => {
        settle(item, SdkStdioTransportError.of("cancelled"));
        Deferred.doneUnsafe(item.cancelled, Effect.void);
      };
      const requestClose = (error?: SdkStdioTransportError): void => {
        if (closed) return;
        closed = true;
        failure = error;
        for (const item of pending) settle(item, error ?? SdkStdioTransportError.of("closed"));
        if (error !== undefined) {
          try {
            onerror?.(error);
          } catch {
            // Error reporting is best effort.
          }
        }
        notifyClose();
        Deferred.doneUnsafe(stop, Effect.void);
      };
      const parseChunk = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          readBuffer.append(Buffer.from(chunk));
        } catch {
          requestClose(SdkStdioTransportError.of("output-limit"));
          return;
        }
        try {
          while (!closed) {
            const message = readBuffer.readMessage();
            if (message === null) break;
            onmessage?.(message);
          }
        } catch {
          requestClose(SdkStdioTransportError.of("read"));
        }
      };
      const readLoop = Deferred.await(start).pipe(
        Effect.andThen(
          Stream.runForEach(process.stdout, (chunk) => Effect.sync(() => parseChunk(chunk))),
        ),
        Effect.match({
          onFailure: (error) => requestClose(genericReadError(error)),
          onSuccess: () => requestClose(),
        }),
      );
      const writeLoop = Effect.forever(
        Queue.take(writeQueue).pipe(
          Effect.flatMap((item) =>
            Effect.suspend(() => {
              // Cancellation clears bytes synchronously, before a queued write
              // can acquire native dispatch authority.
              if (closed || item.bytes === undefined) return Effect.void;
              return Effect.suspend(() => {
                if (closed || item.bytes === undefined) return Effect.void;
                item.dispatched = true;
                return process.write(item.bytes);
              }).pipe(
                // Interrupt owned native-queue waiting too. Bytes already
                // written remain an unknown outcome, not a rollback promise.
                Effect.raceFirst(Deferred.await(item.cancelled)),
                Effect.match({
                  onFailure: () => settle(item, SdkStdioTransportError.of("write")),
                  onSuccess: () => settle(item),
                }),
              );
            }),
          ),
        ),
      ).pipe(Effect.ignore);

      const owner = yield* restore(
        Effect.scoped(
          Effect.gen(function* () {
            yield* readLoop.pipe(Effect.forkScoped);
            yield* Stream.runDrain(process.stderr).pipe(Effect.forkScoped);
            yield* writeLoop.pipe(Effect.forkScoped);
            yield* Deferred.await(stop);
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Queue.shutdown(writeQueue).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  requestClose();
                  readBuffer.clear();
                  if (Exit.isFailure(exit)) completion.reject(SdkStdioTransportError.of("closed"));
                  else completion.resolve();
                }),
              ),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => requestClose()).pipe(Effect.andThen(Fiber.join(owner))),
      );

      return {
        start: () => {
          if (started || closed) return Promise.reject(SdkStdioTransportError.of("closed"));
          started = true;
          Deferred.doneUnsafe(start, Effect.void);
          return Promise.resolve();
        },
        send: (message: JSONRPCMessage, sendOptions?: TransportSendOptions) => {
          if (!started) return Promise.reject(SdkStdioTransportError.of("not-started"));
          if (closed) return Promise.reject(SdkStdioTransportError.of("closed"));
          // Legacy SDK requests do not forward their AbortSignal. They send
          // this public notification instead. Revoke an unsent request before
          // the cancellation notification itself joins the write queue.
          if ("method" in message && message.method === "notifications/cancelled") {
            const requestId = message.params?.requestId;
            for (const item of pending) {
              if (item.requestId === requestId && requestId !== undefined) {
                cancel(item);
                if (!item.dispatched) return Promise.resolve();
                break;
              }
            }
          }
          const signal = sendOptions?.requestSignal;
          if (signal?.aborted) return Promise.reject(SdkStdioTransportError.of("cancelled"));
          let bytes: Uint8Array;
          try {
            bytes = new TextEncoder().encode(serializeMessage(message));
          } catch {
            return Promise.reject(SdkStdioTransportError.of("write"));
          }
          if (
            bytes.byteLength > options.maxWriteBytes ||
            queuedBytes + bytes.byteLength > options.maxWriteBytes
          ) {
            return Promise.reject(SdkStdioTransportError.of("input-limit"));
          }
          const completion = NativePromise.withResolvers<void>();
          {
            const abort = (): void => {
              // Shared stdio cannot retract bytes already submitted to the OS.
              // Never close the shared channel to cancel one request.
              cancel(item);
            };
            const item: PendingWrite = {
              bytes,
              requestId: "method" in message && "id" in message ? message.id : undefined,
              resolve: () => completion.resolve(),
              reject: completion.reject,
              removeListener: () => signal?.removeEventListener("abort", abort),
              cancelled: Deferred.makeUnsafe<void>(),
              dispatched: false,
            };
            pending.add(item);
            queuedBytes += bytes.byteLength;
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            try {
              if (!Queue.offerUnsafe(writeQueue, item))
                settle(item, SdkStdioTransportError.of("write"));
            } catch {
              settle(item, SdkStdioTransportError.of("closed"));
            }
          }
          return completion.promise;
        },
        close: () => {
          requestClose();
          return completion.promise;
        },
        get failure() {
          return failure;
        },
        get onclose() {
          return onclose;
        },
        set onclose(value: Transport["onclose"]) {
          onclose = value;
          if (closed) notifyClose();
        },
        get onerror() {
          return onerror;
        },
        set onerror(value: Transport["onerror"]) {
          onerror = value;
        },
        get onmessage() {
          return onmessage;
        },
        set onmessage(value: Transport["onmessage"]) {
          onmessage = value;
        },
      };
    }),
  );
