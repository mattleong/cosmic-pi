import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { sanitizeDiagnosticError, type StreamingHttpError } from "pi-cosmic-core";
import { decodeImageStreamEvent } from "./protocol.ts";
import { OpenAIImageError, fail, type ExtractedImageResult } from "./types.ts";

const MAX_IMAGE_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 80 * 1024 * 1024;

export const parseImageSse = Effect.fn("OpenAIImage.parseSse")(function* (
  body: Stream.Stream<Uint8Array, StreamingHttpError>,
  mimeType: string,
) {
  const fallbackId = `ig_${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, "0")}`;
  let totalBytes = 0;
  let completed: ExtractedImageResult | undefined;
  let providerFailure: OpenAIImageError | undefined;
  let terminated = false;
  const pendingEvents: Sse.Event[] = [];
  const parser = Sse.makeParser(
    (event) => {
      // Retry directives control EventSource reconnection. This one-shot response
      // has no reconnect transport, so they remain advisory as before.
      if (event._tag === "Event") pendingEvents.push(event);
    },
    { maxEventSize: MAX_SSE_EVENT_CHARS },
  );

  const processData = Effect.fn("OpenAIImage.processSseData")(function* (source: string) {
    const data = source.trim();
    if (!data) return true;
    if (data === "[DONE]") {
      terminated = true;
      return false;
    }
    const rawEvent = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(data).pipe(
      Effect.mapError(() => fail("stream", "Codex image response contained malformed JSON.")),
    );
    const event = yield* decodeImageStreamEvent(rawEvent, mimeType, fallbackId).pipe(
      Effect.mapError(() => fail("stream", "Codex image response contained a malformed event.")),
    );
    switch (event._tag) {
      case "Image":
        if (event.image.data && event.image.status === "completed") {
          completed = event.image;
          return false;
        }
        return true;
      case "ResponseFailed":
        providerFailure = fail("response", sanitizeDiagnosticError(event.message));
        return false;
      case "ProviderError":
        providerFailure = fail(
          "response",
          `Codex image error: ${sanitizeDiagnosticError(event.message)}`,
        );
        return false;
      case "Ignored":
        return true;
    }
  });

  const drainEvents = Effect.fn("OpenAIImage.drainSseEvents")(function* () {
    while (pendingEvents.length > 0) {
      const event = pendingEvents.shift();
      if (event && !(yield* processData(event.data))) return false;
    }
    return true;
  });

  const feed = Effect.fn("OpenAIImage.feedSseParser")(function* (chunk: string) {
    const parserError = parser.feed(chunk);
    if (parserError) return yield* fail("stream", "Codex image response event was too large.");
    return yield* drainEvents();
  });

  const bounded = body.pipe(
    Stream.mapEffect((bytes) => {
      totalBytes += bytes.byteLength;
      return totalBytes > MAX_IMAGE_RESPONSE_BYTES
        ? Effect.fail(fail("stream", "Codex image response was too large."))
        : Effect.succeed(bytes);
    }),
    Stream.decodeText,
  );
  yield* bounded.pipe(
    Stream.runForEachWhile(feed),
    Effect.mapError((error) =>
      error instanceof OpenAIImageError
        ? error
        : fail("stream", "Codex image response stream failed."),
    ),
  );
  // Effect's spec-compliant parser leaves an unterminated final event pending.
  // The provider and the previous parser accept that response shape, so append
  // one synthetic separator after the transport reaches EOF.
  if (!completed && !providerFailure && !terminated) yield* feed("\n\n");
  if (completed) return completed;
  if (providerFailure) return yield* providerFailure;
  return yield* fail("stream", "No completed image_generation_call result returned by Codex.");
});
