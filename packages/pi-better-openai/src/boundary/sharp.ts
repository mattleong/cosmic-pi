import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import sharp from "sharp";

export class SharpError extends Schema.TaggedError<SharpError>()("SharpError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface SharpMetadata {
  readonly format?: string;
}

export interface SharpAdapterShape {
  /** Fully decode the exact bytes that will be uploaded or persisted. */
  readonly decode: (bytes: Uint8Array) => Effect.Effect<SharpMetadata, SharpError>;
}

export class SharpAdapter extends Context.Service<SharpAdapter, SharpAdapterShape>()(
  "pi-better-openai/boundary/sharp/SharpAdapter",
) {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      decode: (bytes) =>
        Effect.tryPromise({
          try: () => {
            const input = sharp(bytes, {
              animated: true,
              failOn: "error",
              limitInputPixels: 40_000_000,
              sequentialRead: true,
            });
            return input.metadata().then((metadata) =>
              input
                .clone()
                .raw()
                .toBuffer()
                .then(() => ({ format: metadata.format })),
            );
          },
          catch: () =>
            new SharpError({ operation: "decode", message: "Image data is not readable." }),
        }),
    }),
  );
}
