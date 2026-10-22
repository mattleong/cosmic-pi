import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const Envelope = Schema.Struct({
  customType: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});

const isTextPart = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

/** A custom message as Pi hands it to a message renderer; its details are decoded by each owner. */
export const decodeMessageEnvelope = Schema.decodeUnknownOption(Envelope, {
  onExcessProperty: "ignore",
});

/** A message's text: string content, or its text parts joined by lines. */
export const messageContentText = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : (content ?? [])
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n");
