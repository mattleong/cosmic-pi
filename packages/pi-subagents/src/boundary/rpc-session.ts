// NDJSON request/response RPC sessions over spawned helper processes live at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as MutableRef from "effect/MutableRef";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { terminateProcessTree } from "./process-tree.ts";

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
  readonly detached?: boolean | undefined;
  /** Bytes allowed on stderr before the session dies; zero pipes nothing and watches nothing. */
  readonly diagnosticMaxBytes: number;
  /** Wait for the child `spawn` event before resolving acquisition. */
  readonly waitForSpawnEvent: boolean;
  readonly maxLineBytes: number;
  readonly maxQueuedOutputBytes: number;
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
    const pending = MutableRef.make<ReadonlyMap<string, PendingEntry<Reply>>>(new Map());
    const frames = yield* Queue.bounded<OutboundFrame>(options.writeQueueCapacity);
    let child: NodeChildProcess | undefined;
    let detachParser: (() => void) | undefined;

    const extractEntry = (id: string): PendingEntry<Reply> | undefined => {
      const current = MutableRef.get(pending);
      const entry = current.get(id);
      if (!entry) return undefined;
      const next = new Map(current);
      next.delete(id);
      MutableRef.set(pending, next);
      return entry;
    };

    const settlePendingWith = (settle: (entry: PendingEntry<Reply>) => void): void => {
      const current = MutableRef.getAndSet(pending, new Map<string, PendingEntry<Reply>>());
      for (const entry of current.values()) settle(entry);
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
      detachParser?.();
      detachParser = undefined;
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.kill();
    };

    const enqueueFrameSync = (frame: OutboundFrame): boolean => {
      if (!child || !alive.isOpen()) return false;
      return Queue.offerUnsafe(frames, frame);
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

    const acquireChild = Effect.callback<NodeChildProcess, RpcSessionTransportError>((resume) => {
      let settled = !options.waitForSpawnEvent;
      let acquired: NodeChildProcess;
      try {
        acquired = spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: options.environment,
          detached: options.detached ?? false,
          stdio: [
            "pipe",
            "pipe",
            options.diagnosticMaxBytes > 0 ? "pipe" : "ignore",
          ] satisfies Array<"pipe" | "ignore">,
          windowsHide: true,
        });
      } catch {
        resume(Effect.fail(transportClosed()));
        return;
      }
      if (settled) {
        resume(Effect.succeed(acquired));
        return;
      }
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        acquired.off("error", onError);
        resume(Effect.succeed(acquired));
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        acquired.off("spawn", onSpawn);
        resume(Effect.fail(transportClosed()));
      };
      acquired.once("spawn", onSpawn);
      acquired.once("error", onError);
    });

    child = yield* acquireChild;

    yield* Effect.forever(
      Effect.gen(function* () {
        const item = yield* Queue.take(frames);
        yield* writeToStdin(item.line).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              if (item.ack) Deferred.doneUnsafe(item.ack, Effect.fail(error));
              failSessionSync(error);
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              if (item.ack) Deferred.doneUnsafe(item.ack, Effect.void);
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

    const process_ = child;
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
          observedBytes += Buffer.byteLength(line, "utf8");
          if (observedBytes > options.maxQueuedOutputBytes) {
            failSessionSync(
              new RpcSessionTransportError({
                message: "Helper output exceeded its bounded buffer.",
              }),
            );
            return;
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

    const terminateTree = Effect.tryPromise({
      try: () => terminateProcessTree(process_, "force"),
      catch: () => cleanupUnconfirmed(),
    });

    const teardown = Effect.uninterruptible(
      Effect.gen(function* () {
        const wasOpen = alive.isOpen();
        failSessionSync(transportClosed());
        yield* Queue.shutdown(frames);
        if (wasOpen && process_.exitCode === null && process_.signalCode === null) {
          yield* terminateTree.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Helper process tree termination was not confirmed."),
            ),
          );
        }
      }),
    );

    const session: NdjsonRpcSession<Reply> = {
      call: (id, frame, timeoutMillis) =>
        Effect.suspend(() => {
          if (!alive.isOpen()) {
            const failure = transportClosed();
            return Effect.fail(failure);
          }
          const current = MutableRef.get(pending);
          if (current.has(id)) {
            return Effect.fail(
              new RpcSessionCapacityError({
                message: "A call with this identifier is already in flight.",
              }),
            );
          }
          if (current.size >= options.maxPendingCalls) {
            return Effect.fail(
              new RpcSessionCapacityError({
                message: "The helper process session is at its concurrent-call bound.",
              }),
            );
          }
          const reply = Deferred.makeUnsafe<Reply, RpcSessionError>();
          const next = new Map(current);
          next.set(id, { reply });
          MutableRef.set(pending, next);

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
        Effect.callback<void, RpcSessionError>((resume) => {
          if (!alive.isOpen()) {
            resume(Effect.fail(transportClosed()));
            return;
          }
          if (Buffer.byteLength(frame, "utf8") > options.maxLineBytes) {
            resume(
              Effect.fail(
                new RpcSessionCapacityError({
                  message: "A helper process notification exceeds its frame bound.",
                }),
              ),
            );
            return;
          }
          const ack = Deferred.makeUnsafe<void, RpcSessionError>();
          if (!enqueueFrameSync({ line: frame, ack })) {
            resume(Effect.fail(transportClosed()));
            return;
          }
          resume(Deferred.await(ack));
        }),

      close: () =>
        Effect.gen(function* () {
          failSessionSync(transportClosed());
          yield* Queue.shutdown(frames);
          if (process_.exitCode !== null || process_.signalCode !== null) return;
          yield* terminateTree;
        }),
    };

    yield* Effect.addFinalizer(() => teardown);

    return session;
  });

export { makeNdjsonRpcSession };
