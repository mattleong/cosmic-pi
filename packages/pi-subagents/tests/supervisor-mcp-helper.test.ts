import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Writable } from "node:stream";
import { makeSerializedWriter } from "../src/boundary/supervisor-mcp-writer.ts";

it.effect("writer scope closure settles queued acknowledgements despite stalled stdout", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stream = new Writable({
      write() {
        Deferred.doneUnsafe(started, Effect.void);
        // Hold the native callback indefinitely, as with a backpressured pipe.
      },
    });
    const { writer, acknowledgements } = yield* Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* makeSerializedWriter(stream);
        const acknowledgements = [writer.write({ id: 1 }), writer.write({ id: 2 })];
        yield* Deferred.await(started);
        return { writer, acknowledgements };
      }),
    );
    for (const acknowledgement of acknowledgements) {
      expect(yield* Effect.flip(acknowledgement)).toMatchObject({ reason: "closed" });
    }
    writer.close();
    expect(yield* Effect.flip(writer.write({ id: 3 }))).toMatchObject({ reason: "closed" });
    stream.destroy();
  }),
);
