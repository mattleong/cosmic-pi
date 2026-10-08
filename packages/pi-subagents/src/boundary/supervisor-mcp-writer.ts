import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { MAX_SUPERVISOR_CHANNEL_LINE_BYTES } from "../supervisor/protocol.ts";

const MAX_PENDING_WRITES = 64;

export class McpWriteFailure extends Schema.TaggedError<McpWriteFailure>()("McpWriteFailure", {
  reason: Schema.Literals(["capacity", "closed", "size", "stream"]),
}) {}

export const makeSerializedWriter = Effect.fn("SupervisorMcpHelper.makeSerializedWriter")(
  function* (stream: Pick<NodeJS.WritableStream, "write">) {
    const frames = yield* Queue.bounded<{
      readonly line: string;
      readonly ack: Deferred.Deferred<void, McpWriteFailure>;
    }>(MAX_PENDING_WRITES);
    const acknowledgements = new Set<Deferred.Deferred<void, McpWriteFailure>>();
    let closed = false;
    const writeLine = (line: string) =>
      Effect.callback<void, McpWriteFailure>((resume) => {
        stream.write(line, "utf8", (error?: Error | null) =>
          resume(error ? Effect.fail(new McpWriteFailure({ reason: "stream" })) : Effect.void),
        );
      });
    yield* Effect.forever(
      Queue.take(frames).pipe(
        Effect.flatMap((frame) =>
          Effect.exit(writeLine(frame.line)).pipe(
            Effect.flatMap((exit) => Deferred.done(frame.ack, exit)),
            Effect.ensuring(Effect.sync(() => acknowledgements.delete(frame.ack))),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    // Native ingress reserves capacity synchronously. The returned Effect only awaits that
    // frame's acknowledgement; interrupting its waiter cannot enqueue or publish a second frame.
    const write = <ValueInput>(value: ValueInput): Effect.Effect<void, McpWriteFailure> => {
      if (closed) return Effect.fail(new McpWriteFailure({ reason: "closed" }));
      if (acknowledgements.size >= MAX_PENDING_WRITES)
        return Effect.fail(new McpWriteFailure({ reason: "capacity" }));
      const line = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(line, "utf8") > MAX_SUPERVISOR_CHANNEL_LINE_BYTES)
        return Effect.fail(new McpWriteFailure({ reason: "size" }));
      const ack = Deferred.makeUnsafe<void, McpWriteFailure>();
      acknowledgements.add(ack);
      if (!Queue.offerUnsafe(frames, { line, ack })) {
        acknowledgements.delete(ack);
        return Effect.fail(new McpWriteFailure({ reason: "capacity" }));
      }
      return Deferred.await(ack);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      const failure = new McpWriteFailure({ reason: "closed" });
      for (const acknowledgement of acknowledgements)
        Deferred.doneUnsafe(acknowledgement, Effect.fail(failure));
      acknowledgements.clear();
    };
    // Also cover startup failure before the helper installs its earlier ordered input close.
    yield* Effect.addFinalizer(() => Effect.sync(close));
    return { write, close };
  },
);
