import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { makeSerializedWriter } from "../src/boundary/supervisor-mcp-writer.ts";

it.effect("writer scope closure settles queued acknowledgements despite stalled stdout", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stream: Pick<NodeJS.WritableStream, "write"> = {
      write() {
        Deferred.doneUnsafe(started, Effect.void);
        return false;
      },
    };
    const { writer, acknowledgements } = yield* Effect.scoped(
      Effect.gen(function* () {
        const scopedWriter = yield* makeSerializedWriter(stream);
        const queued = [scopedWriter.write({ id: 1 }), scopedWriter.write({ id: 2 })];
        yield* Deferred.await(started);
        return { writer: scopedWriter, acknowledgements: queued };
      }),
    );
    for (const acknowledgement of acknowledgements) {
      expect(yield* Effect.flip(acknowledgement)).toMatchObject({ reason: "closed" });
    }
    writer.close();
    expect(yield* Effect.flip(writer.write({ id: 3 }))).toMatchObject({ reason: "closed" });
  }),
);
