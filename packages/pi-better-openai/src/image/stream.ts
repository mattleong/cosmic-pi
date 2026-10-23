import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as Sse from "effect/encoding/Sse";
import { sanitizeDiagnosticError } from "pi-cosmic-core/security";
import { type StreamingHttpError } from "pi-cosmic-core/platform/errors";
import { decodeImageStreamEvent } from "./protocol.ts";
import { fail, type ExtractedImageResult, type OpenAIImageError } from "./types.ts";

const MAX_IMAGE_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 80 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

const ProviderMessageSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ message: Schema.String }),
]);
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ error: ProviderMessageSchema }),
      Schema.Struct({ detail: ProviderMessageSchema }),
      Schema.Struct({ message: Schema.String }),
    ]),
  ),
);
const decodeSseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const messageText = (message: typeof ProviderMessageSchema.Type) =>
  Predicate.isString(message) ? message : message.message;
const errorBodyReason = (text: string) => {
  const reason = Option.getOrUndefined(
    Option.map(decodeErrorBody(text), (body) => {
      if ("error" in body) return messageText(body.error);
      return "detail" in body ? messageText(body.detail) : body.message;
    }),
  );
  return reason === undefined ? undefined : Str.trim(reason);
};

const leadingBytes = (body: Stream.Stream<Uint8Array, StreamingHttpError>, limit: number) => {
  let remaining = limit;
  return body.pipe(
    Stream.takeWhile(() => remaining > 0),
    Stream.map((chunk) => {
      const slice = chunk.subarray(0, remaining);
      remaining -= slice.byteLength;
      return slice;
    }),
  );
};

/**
 * Failure for a non-2xx reply. Only a bounded prefix of the body is read, and only the provider's
 * JSON error message is reported, sanitized like mid-stream provider errors.
 */
export const httpFailure = Effect.fn("OpenAIImage.httpFailure")(function* (
  status: number,
  body: Stream.Stream<Uint8Array, StreamingHttpError>,
) {
  const text = yield* leadingBytes(body, MAX_ERROR_BODY_BYTES).pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.timeout("1 second"),
    Effect.orElseSucceed(() => ""),
  );
  const reason = errorBodyReason(text);
  return yield* fail(
    "request",
    reason
      ? `Codex image request failed (${status}): ${sanitizeDiagnosticError(reason)}`
      : `Codex image request failed (${status}).`,
  );
});

export const parseImageSse = Effect.fn("OpenAIImage.parseSse")(function* (
  body: Stream.Stream<Uint8Array, StreamingHttpError>,
  mimeType: string,
) {
  const fallbackId = `ig_${Fn.pipe((yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16), Str.padStart(8, "0"))}`;
  let totalBytes = 0;
  let completed: ExtractedImageResult | undefined;
  let providerFailure: OpenAIImageError | undefined;
  // A failed item carries no reason; keep reading so a later response failure can supply one.
  let imageFailed = false;
  let terminated = false;
  const pendingEvents: Sse.Event[] = [];
  const parser = Sse.makeParser(
    (event) => {
      if (Predicate.isTagged(event, "Event")) pendingEvents.push(event);
    },
    { maxEventSize: MAX_SSE_EVENT_CHARS },
  );

  const processData = Effect.fn("OpenAIImage.processSseData")(function* (source: string) {
    const data = Str.trim(source);
    if (!data) return true;
    if (data === "[DONE]") {
      terminated = true;
      return false;
    }
    const rawEvent = yield* decodeSseJson(data).pipe(
      Effect.mapError(() => fail("stream", "Codex image response contained malformed JSON.")),
    );
    const event = yield* decodeImageStreamEvent(rawEvent, mimeType, fallbackId).pipe(
      Effect.mapError(() => fail("stream", "Codex image response contained a malformed event.")),
    );
    return Match.valueTags(event, {
      Image: ({ image }) => {
        if (image.data && image.status === "completed") {
          completed = image;
          return false;
        }
        return true;
      },
      ImageFailed: () => {
        imageFailed = true;
        return true;
      },
      ResponseFailed: ({ message }) => {
        providerFailure = fail("response", sanitizeDiagnosticError(message));
        return false;
      },
      ProviderError: ({ message }) => {
        providerFailure = fail(
          "response",
          `Codex image error: ${sanitizeDiagnosticError(message)}`,
        );
        return false;
      },
      Ignored: () => true,
    });
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
    Effect.catchTag("StreamingHttpError", () =>
      Effect.fail(fail("stream", "Codex image response stream failed.")),
    ),
  );
  if (!completed && !providerFailure && !terminated) yield* feed("\n\n");
  if (completed) return completed;
  if (providerFailure) return yield* providerFailure;
  if (imageFailed) return yield* fail("response", "Codex image generation failed.");
  return yield* fail("stream", "No completed image_generation_call result returned by Codex.");
});
