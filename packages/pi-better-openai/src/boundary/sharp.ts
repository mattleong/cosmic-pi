import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  runBoundedProcessNode,
  type BoundedProcessError,
  type BoundedProcessResult,
} from "pi-cosmic-core";

export class SharpError extends Schema.TaggedError<SharpError>()("SharpError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface SharpMetadata {
  readonly format?: string;
}

export interface SharpAdapterContract {
  /** Fully decode the exact bytes that will be uploaded or persisted. */
  readonly decode: (bytes: Uint8Array) => Effect.Effect<SharpMetadata, SharpError>;
}

const maximumInputBytes = 60 * 1024 * 1024;
const maximumOutputBytes = 128;
const metadataSchema = Schema.fromJsonString(
  Schema.Struct({ format: Schema.Literals(["png", "jpeg", "jpg", "webp", "gif"]) }),
);
const decodeMetadata = Schema.decodeUnknownEffect(metadataSchema, { onExcessProperty: "error" });
const decodeError = () =>
  new SharpError({ operation: "decode", message: "Image data is not readable." });

// Independently built session runtimes share immediate admission. Never queue image buffers.
const admission = Semaphore.makeUnsafe(1);
const disabled = MutableRef.make(false);

/** Owned runner seam. Report confirmed exit from scoped cleanup, even on interruption.
 * Returning from the platform scope alone is not proof that its child exited.
 */
export type SharpProcessRunner = (
  bytes: Uint8Array,
  onCleanup: (confirmed: boolean) => void,
) => Effect.Effect<BoundedProcessResult, BoundedProcessError>;

const runDecoder: SharpProcessRunner = (bytes, onCleanup) =>
  runBoundedProcessNode({
    executable: process.execPath,
    args: [fileURLToPath(new URL("./sharp-decoder.mjs", import.meta.url))],
    stdin: bytes,
    stdoutLimitBytes: maximumOutputBytes,
    stderrLimitBytes: 128,
    totalOutputLimitBytes: 256,
    timeoutMillis: 30_000,
    cleanupTimeoutMillis: 2_000,
    onCleanup,
    windowsHide: true,
  });

export const makeSharpAdapter = (run: SharpProcessRunner = runDecoder): SharpAdapterContract => ({
  decode: (bytes) =>
    Effect.suspend(() => {
      if (bytes.byteLength > maximumInputBytes || bytes.byteLength === 0)
        return Effect.fail(decodeError());
      return Effect.gen(function* () {
        if (MutableRef.get(disabled)) return yield* decodeError();
        let cleanupConfirmed = false;
        const result = yield* Effect.suspend(() =>
          run(bytes, (confirmed) => {
            cleanupConfirmed = confirmed;
          }),
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.cleanupUnconfirmed) cleanupConfirmed = false;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              // This commit precedes permit release on success, error and cancellation.
              if (!cleanupConfirmed) MutableRef.set(disabled, true);
            }),
          ),
        );
        if (
          !cleanupConfirmed ||
          result.code !== 0 ||
          result.signal !== null ||
          result.timedOut ||
          result.overflowed ||
          result.cleanupUnconfirmed ||
          Buffer.byteLength(result.stdout) > maximumOutputBytes
        )
          return yield* decodeError();
        return yield* decodeMetadata(result.stdout);
      }).pipe(
        // The runner's whole scoped cleanup is inside the permit, including cancellation.
        admission.withPermitsIfAvailable(1),
        Effect.flatMap((result) => Effect.fromOption(result)),
        Effect.mapError(decodeError),
      );
    }),
});

export class SharpAdapter extends Context.Service<SharpAdapter, SharpAdapterContract>()(
  "pi-better-openai/boundary/sharp/SharpAdapter",
) {
  static readonly layer = Layer.succeed(this, this.of(makeSharpAdapter()));
}
