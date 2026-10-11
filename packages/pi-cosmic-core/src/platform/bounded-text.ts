import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const collectBoundedText = <E, TooLarge>(
  bytes: Stream.Stream<Uint8Array, E>,
  maximumBytes: number,
  tooLarge: () => TooLarge,
): Effect.Effect<string, E | TooLarge> =>
  Effect.suspend(() => {
    const decoder = new TextDecoder();
    let total = 0;
    return bytes.pipe(
      Stream.mapEffect((chunk) =>
        (total += chunk.byteLength) > maximumBytes
          ? Effect.fail(tooLarge())
          : Effect.succeed(decoder.decode(chunk, { stream: true })),
      ),
      Stream.mkString,
      Effect.map((text) => text + decoder.decode()),
    );
  });
