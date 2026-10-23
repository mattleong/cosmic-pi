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

export class SharpError extends Schema.TaggedError<SharpError, { readonly brand: unique symbol }>()(
  "SharpError",
  {
    operation: Schema.Literals(["decode", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface SharpMetadata {
  readonly format?: string;
}

export interface SharpAdapterContract {
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
const unavailableError = () =>
  new SharpError({
    operation: "unavailable",
    message:
      "Image decoding is disabled until Pi restarts: a previous decoder did not confirm exit.",
  });

/**
 * One decoder runs at a time; later calls wait interruptibly for the permit. A decoder whose
 * cleanup was unconfirmed disables decoding, because its child may still hold resources.
 * Production adapters share one process-wide admission.
 */
export interface SharpAdmission {
  readonly permit: Semaphore.Semaphore;
  readonly disabled: MutableRef.MutableRef<boolean>;
}

export const createSharpAdmission = (): SharpAdmission => ({
  permit: Semaphore.makeUnsafe(1),
  disabled: MutableRef.make(false),
});

const processAdmission = createSharpAdmission();

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
  });

export const makeSharpAdapter = (
  run: SharpProcessRunner = runDecoder,
  { permit, disabled }: SharpAdmission = processAdmission,
): SharpAdapterContract => ({
  decode: (bytes) =>
    bytes.byteLength > maximumInputBytes || bytes.byteLength === 0
      ? Effect.fail(decodeError())
      : Effect.gen(function* () {
          if (MutableRef.get(disabled)) return yield* unavailableError();
          let cleanupConfirmed = false;
          const result = yield* Effect.suspend(() =>
            run(bytes, (confirmed) => {
              cleanupConfirmed = confirmed;
            }),
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (outcome.cleanupUnconfirmed) cleanupConfirmed = false;
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (!cleanupConfirmed) MutableRef.set(disabled, true);
              }),
            ),
            Effect.mapError(decodeError),
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
          return yield* decodeMetadata(result.stdout).pipe(Effect.mapError(decodeError));
        }).pipe(permit.withPermits(1)),
});

export class SharpAdapter extends Context.Service<SharpAdapter, SharpAdapterContract>()(
  "pi-better-openai/boundary/sharp/SharpAdapter",
) {
  static readonly layer = Layer.succeed(this, this.of(makeSharpAdapter()));
}
