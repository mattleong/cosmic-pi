// NDJSON request/response RPC sessions over spawned helper processes live at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { awaitProcessClose } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { terminateProcessTreeEffect } from "./process-tree.ts";

export class RpcSessionTransportError extends Schema.TaggedError<RpcSessionTransportError>()(
  "RpcSessionTransportError",
  { message: Schema.String },
) {}

export class RpcSessionCapacityError extends Schema.TaggedError<RpcSessionCapacityError>()(
  "RpcSessionCapacityError",
  { message: Schema.String },
) {}

export class RpcCallTimeoutError extends Schema.TaggedError<RpcCallTimeoutError>()(
  "RpcCallTimeoutError",
  { message: Schema.String },
) {}

export class RpcCallRejectedError extends Schema.TaggedError<RpcCallRejectedError>()(
  "RpcCallRejectedError",
  { detail: Schema.String },
) {}

export type RpcSessionError =
  | RpcSessionTransportError
  | RpcSessionCapacityError
  | RpcCallTimeoutError
  | RpcCallRejectedError;

export type InboundClassification<Reply> =
  | { readonly kind: "reply"; readonly id: string; readonly value: Reply }
  | { readonly kind: "rejection"; readonly id: string; readonly detail: string }
  | { readonly kind: "ignore" }
  | { readonly kind: "protocol-error"; readonly reason: string };

export interface NdjsonRpcSessionOptions<Reply> {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Bytes allowed on stderr before the session dies; zero pipes nothing and watches nothing. */
  readonly diagnosticMaxBytes: number;
  /** Wait for the child `spawn` event before resolving acquisition. */
  readonly waitForSpawnEvent: boolean;
  readonly maxLineBytes: number;
  readonly maxQueuedOutputBytes: number;
  /** Optional lifetime cap for short-lived probes; long-lived sessions leave this unset. */
  readonly maxTotalOutputBytes?: number | undefined;
  readonly maxPendingCalls: number;
  readonly writeQueueCapacity: number;
  readonly classifyInbound: (line: string) => InboundClassification<Reply>;
  readonly unknownReplyPolicy: "ignore" | "fail-session";
  /** Best-effort pre-encoded frame emitted when a call leaves without its reply. */
  readonly cancelNotification?: ((id: string) => string | undefined) | undefined;
}

interface PendingEntry<Reply> {
  readonly reply: Deferred.Deferred<Reply, RpcSessionError>;
}

interface OutboundFrame {
  readonly line: string;
  readonly ack?: Deferred.Deferred<void, RpcSessionError> | undefined;
}

export interface NdjsonRpcSession<Reply> {
  /** `frame` is a consumer-encoded NDJSON line including its trailing newline. */
  readonly call: (
    id: string,
    frame: string,
    timeoutMillis: number,
  ) => Effect.Effect<Reply, RpcSessionError>;
  readonly notify: (frame: string) => Effect.Effect<void, RpcSessionError>;
  /**
   * Terminal teardown that reports cleanup confirmation. Scope release performs the same
   * teardown best-effort, so explicit `close` is optional.
   */
  readonly close: () => Effect.Effect<void, RpcSessionTransportError>;
}

const transportClosed = () =>
  new RpcSessionTransportError({ message: "The helper process session is no longer available." });

const deliveryUncertain = () =>
  new RpcSessionTransportError({
    message: "A helper process frame could not be delivered; outcome is uncertain.",
  });

const cleanupUnconfirmed = () =>
  new RpcSessionTransportError({
    message: "Helper process cleanup could not be confirmed.",
  });

const makeNdjsonRpcSession = <Reply>(
  options: NdjsonRpcSessionOptions<Reply>,
): Effect.Effect<NdjsonRpcSession<Reply>, RpcSessionTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const alive = yield* Latch.make(true);
    const pending = new Map<string, PendingEntry<Reply>>();
    const frames = yield* Queue.bounded<OutboundFrame>(options.writeQueueCapacity);
    const sessionFailed = Deferred.makeUnsafe<RpcSessionTransportError>();
    const cleanupDone = Deferred.makeUnsafe<void, RpcSessionTransportError>();
    const outstandingNotifyAcks = new Set<Deferred.Deferred<void, RpcSessionError>>();
    let cleanupStarted = false;
    let child: NodeChildProcess | undefined;
    let detachParser: (() => void) | undefined;

    const extractEntry = (id: string): PendingEntry<Reply> | undefined => {
      const entry = pending.get(id);
      if (!entry) return undefined;
      pending.delete(id);
      return entry;
    };

    const settlePendingWith = (settle: (entry: PendingEntry<Reply>) => void): void => {
      for (const entry of pending.values()) settle(entry);
      pending.clear();
    };

    // Runs from both fiber and Node-callback contexts, so every step is synchronous.
    // The frame queue is not shut down here because this may run inside a Node callback;
    // fiber-context teardown shuts it down explicitly. Post-death writes are rejected by
    // the admission latch instead.
    const failSessionSync = (error: RpcSessionTransportError): void => {
      if (!alive.isOpen()) return;
      Latch.closeUnsafe(alive);
      settlePendingWith((entry) => {
        Deferred.doneUnsafe(entry.reply, Effect.fail(error));
      });
      for (const ack of outstandingNotifyAcks) Deferred.doneUnsafe(ack, Effect.fail(error));
      outstandingNotifyAcks.clear();
      Deferred.doneUnsafe(sessionFailed, Effect.succeed(error));
      detachParser?.();
      detachParser = undefined;
      child?.stdin?.destroy();
      child?.stdout?.destroy();
    };

    const settleFrameAck = (
      frame: OutboundFrame,
      result: Effect.Effect<void, RpcSessionError>,
    ): void => {
      if (!frame.ack) return;
      outstandingNotifyAcks.delete(frame.ack);
      Deferred.doneUnsafe(frame.ack, result);
    };

    const enqueueFrameSync = (frame: OutboundFrame): boolean => {
      if (!child || !alive.isOpen()) return false;
      if (frame.ack) outstandingNotifyAcks.add(frame.ack);
      const offered = Queue.offerUnsafe(frames, frame);
      if (!offered && frame.ack) outstandingNotifyAcks.delete(frame.ack);
      return offered;
    };

    const sendCancelNotification = (id: string): void => {
      if (!options.cancelNotification) return;
      const frame = options.cancelNotification(id);
      if (frame === undefined) return;
      enqueueFrameSync({ line: frame });
    };

    const writeToStdin = (line: string) =>
      Effect.callback<void, RpcSessionTransportError>((resume) => {
        const stdin = child?.stdin;
        if (!stdin || stdin.destroyed || !alive.isOpen()) {
          resume(Effect.fail(transportClosed()));
          return;
        }
        stdin.write(line, "utf8", (error) =>
          resume(error ? Effect.fail(deliveryUncertain()) : Effect.void),
        );
      });

    const terminateTreeFor = (process_: NodeChildProcess) =>
      terminateProcessTreeEffect(process_, "force").pipe(
        Effect.mapError(() => cleanupUnconfirmed()),
      );

    const terminateAndConfirm = (process_: NodeChildProcess) =>
      Effect.gen(function* () {
        // POSIX groups remain addressable after the leader exits, so always sweep them.
        if (process_.exitCode !== null) {
          if (process.platform !== "win32") yield* terminateTreeFor(process_);
          return;
        }
        const closeConfirmation = awaitProcessClose(process_, 2_000);
        if (process.platform !== "win32" || process_.signalCode === null)
          yield* terminateTreeFor(process_);
        if (!(yield* closeConfirmation)) return yield* cleanupUnconfirmed();
      });

    const closeOwnedProcess = (process_: NodeChildProcess) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (cleanupStarted) return Deferred.await(cleanupDone);
          cleanupStarted = true;
          return Effect.gen(function* () {
            failSessionSync(transportClosed());
            const discarded = yield* Queue.clear(frames).pipe(
              Effect.catchCause(() => Effect.succeed<Array<OutboundFrame>>([])),
            );
            for (const frame of discarded) settleFrameAck(frame, Effect.fail(transportClosed()));
            yield* Queue.shutdown(frames);
            yield* terminateAndConfirm(process_);
          }).pipe(Effect.onExit((exit) => Deferred.done(cleanupDone, exit).pipe(Effect.asVoid)));
        }),
      );

    const teardown = (process_: NodeChildProcess) =>
      Effect.uninterruptible(
        closeOwnedProcess(process_).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Helper process tree termination was not confirmed."),
          ),
        ),
      );

    const acquireChild = Effect.callback<NodeChildProcess, RpcSessionTransportError>((resume) => {
      let settled = !options.waitForSpawnEvent;
      let acquired: NodeChildProcess | undefined;
      const detachSpawnListeners = () => {
        acquired?.off("spawn", onSpawn);
        acquired?.off("error", onError);
      };
      const onSpawn = () => {
        if (settled || !acquired) return;
        settled = true;
        detachSpawnListeners();
        resume(Effect.succeed(acquired));
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        detachSpawnListeners();
        resume(Effect.fail(transportClosed()));
      };
      try {
        acquired = spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: options.environment,
          detached: process.platform !== "win32",
          stdio: [
            "pipe",
            "pipe",
            options.diagnosticMaxBytes > 0 ? "pipe" : "ignore",
          ] satisfies Array<"pipe" | "ignore">,
          windowsHide: true,
        });
      } catch {
        settled = true;
        resume(Effect.fail(transportClosed()));
        return Effect.void;
      }
      if (settled) resume(Effect.succeed(acquired));
      else {
        acquired.once("spawn", onSpawn);
        acquired.once("error", onError);
      }
      return Effect.suspend(() => {
        if (settled || !acquired) return Effect.void;
        settled = true;
        detachSpawnListeners();
        acquired.stdin?.destroy();
        acquired.stdout?.destroy();
        return terminateAndConfirm(acquired).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Interrupted helper acquisition cleanup was not confirmed."),
          ),
        );
      });
    });

    child = yield* Effect.acquireRelease(acquireChild, teardown);
    const process_ = child;

    yield* Deferred.await(sessionFailed).pipe(
      Effect.andThen(closeOwnedProcess(process_)),
      Effect.catchCause(() =>
        Effect.logWarning("Failed helper session cleanup could not be confirmed."),
      ),
      Effect.forkScoped,
    );

    yield* Effect.forever(
      Effect.gen(function* () {
        const item = yield* Queue.take(frames);
        yield* writeToStdin(item.line).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              settleFrameAck(item, Effect.fail(error));
              failSessionSync(error);
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              settleFrameAck(item, Effect.void);
            }),
          ),
        );
      }),
    ).pipe(Effect.ignore, Effect.forkScoped);

    const classifyLine = (line: string): void => {
      const classified = options.classifyInbound(line);
      switch (classified.kind) {
        case "reply": {
          const entry = extractEntry(classified.id);
          if (entry) {
            Deferred.doneUnsafe(entry.reply, Effect.succeed(classified.value));
            return;
          }
          if (options.unknownReplyPolicy === "fail-session") {
            failSessionSync(
              new RpcSessionTransportError({
                message: "The helper process replied to an unknown request.",
              }),
            );
          }
          return;
        }
        case "rejection": {
          const entry = extractEntry(classified.id);
          if (entry) {
            Deferred.doneUnsafe(
              entry.reply,
              Effect.fail(new RpcCallRejectedError({ detail: classified.detail })),
            );
            return;
          }
          if (options.unknownReplyPolicy === "fail-session") {
            failSessionSync(
              new RpcSessionTransportError({
                message: "The helper process replied to an unknown request.",
              }),
            );
          }
          return;
        }
        case "ignore":
          return;
        case "protocol-error":
          failSessionSync(new RpcSessionTransportError({ message: classified.reason }));
          return;
      }
    };

    if (process_.stdout) {
      let observedBytes = 0;
      detachParser = attachBoundedLineParser(process_.stdout, {
        maxLineBytes: options.maxLineBytes,
        maxQueuedBytes: options.maxQueuedOutputBytes,
        onOverflow: () => {
          failSessionSync(
            new RpcSessionTransportError({
              message: "Helper output exceeded its bounded buffer.",
            }),
          );
        },
        onLine: (line) => {
          if (options.maxTotalOutputBytes !== undefined) {
            observedBytes += Buffer.byteLength(line, "utf8");
            if (observedBytes > options.maxTotalOutputBytes) {
              failSessionSync(
                new RpcSessionTransportError({
                  message: "Helper output exceeded its bounded buffer.",
                }),
              );
              return;
            }
          }
          classifyLine(line);
        },
      });
    }

    if (process_.stderr && options.diagnosticMaxBytes > 0) {
      const stderr = process_.stderr;
      let diagnosticBytes = 0;
      const onDiagnostic = (chunk: Buffer | string): void => {
        diagnosticBytes += Buffer.byteLength(chunk);
        if (diagnosticBytes > options.diagnosticMaxBytes) {
          stderr.off("data", onDiagnostic);
          failSessionSync(
            new RpcSessionTransportError({ message: "Helper diagnostics exceeded their bound." }),
          );
        }
      };
      stderr.on("data", onDiagnostic);
    }

    process_.once("error", () => {
      failSessionSync(new RpcSessionTransportError({ message: "The helper process failed." }));
    });
    process_.once("close", () => {
      failSessionSync(new RpcSessionTransportError({ message: "The helper process closed." }));
    });

    const session: NdjsonRpcSession<Reply> = {
      call: (id, frame, timeoutMillis) =>
        Effect.suspend(() => {
          if (!alive.isOpen()) {
            const failure = transportClosed();
            return Effect.fail(failure);
          }
          if (pending.has(id)) {
            return Effect.fail(
              new RpcSessionCapacityError({
                message: "A call with this identifier is already in flight.",
              }),
            );
          }
          if (pending.size >= options.maxPendingCalls) {
            return Effect.fail(
              new RpcSessionCapacityError({
                message: "The helper process session is at its concurrent-call bound.",
              }),
            );
          }
          const reply = Deferred.makeUnsafe<Reply, RpcSessionError>();
          pending.set(id, { reply });

          const awaitReply = Deferred.await(reply).pipe(
            // Interruption (caller abort or timeout) still runs this finalizer; success skips it.
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.sync(() => {
                    if (!extractEntry(id)) return;
                    sendCancelNotification(id);
                  }),
            ),
          );

          if (Buffer.byteLength(frame, "utf8") > options.maxLineBytes) {
            extractEntry(id);
            return Effect.fail(
              new RpcSessionCapacityError({
                message: "A helper process request exceeds its frame bound.",
              }),
            );
          }
          if (!enqueueFrameSync({ line: frame })) {
            extractEntry(id);
            return Effect.fail(transportClosed());
          }
          return awaitReply.pipe(
            Effect.timeout(timeoutMillis),
            Effect.mapError((error) =>
              Cause.isTimeoutError(error)
                ? new RpcCallTimeoutError({
                    message: `Helper process call ${id} timed out.`,
                  })
                : error,
            ),
          );
        }),

      notify: (frame) =>
        Effect.suspend(() => {
          if (!alive.isOpen()) return Effect.fail(transportClosed());
          if (Buffer.byteLength(frame, "utf8") > options.maxLineBytes)
            return Effect.fail(
              new RpcSessionCapacityError({
                message: "A helper process notification exceeds its frame bound.",
              }),
            );
          const ack = Deferred.makeUnsafe<void, RpcSessionError>();
          if (!enqueueFrameSync({ line: frame, ack })) return Effect.fail(transportClosed());
          return Deferred.await(ack).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                outstandingNotifyAcks.delete(ack);
              }),
            ),
          );
        }),

      close: () => closeOwnedProcess(process_),
    };

    return session;
  });

export { makeNdjsonRpcSession };
