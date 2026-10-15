import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { JsonDocumentStore } from "../../src/platform/json-document.ts";
import { fileLayer } from "../../src/platform/node.ts";
import { incrementDocumentCount } from "../support/json-documents.ts";

const [documentPath = "", mode = "increment", rounds = "1"] = process.argv.slice(2);

// Holds the document lock until the test kills this process; the timer keeps the process alive.
const hold = JsonDocumentStore.use((store) =>
  store.modifyObject(documentPath, () =>
    Effect.sync(() => process.send?.("locked")).pipe(
      Effect.andThen(Effect.sleep("1 hour")),
      Effect.andThen(Effect.never),
    ),
  ),
);

const increments = Effect.repeat(incrementDocumentCount(documentPath), {
  times: Number(rounds) - 1,
});

process.send?.("started");
Effect.runFork(
  Effect.exit((mode === "hold" ? hold : increments).pipe(Effect.provide(fileLayer))).pipe(
    Effect.flatMap((exit) =>
      Effect.sync(() => {
        process.send?.(Exit.isSuccess(exit) ? "finished" : "failed");
        process.disconnect?.();
      }),
    ),
  ),
);
