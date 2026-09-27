import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { toolError, type ToolError } from "../boundary/codemode-runtime.ts";
import { decodeOption } from "./format.ts";

const SafeNatural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const PositiveSafeInteger = SafeNatural.check(Schema.isGreaterThan(0));

const NativeReadTruncationSchema = Schema.Struct({
  content: Schema.String,
  truncated: Schema.Boolean,
  truncatedBy: Schema.Union([Schema.Literals(["lines", "bytes"]), Schema.Null]),
  totalLines: SafeNatural,
  totalBytes: SafeNatural,
  outputLines: SafeNatural,
  outputBytes: SafeNatural,
  lastLinePartial: Schema.Boolean,
  firstLineExceedsLimit: Schema.Boolean,
  maxLines: PositiveSafeInteger,
  maxBytes: PositiveSafeInteger,
});

const NativeReadDetailsSchema = Schema.Struct({
  truncation: NativeReadTruncationSchema,
});

const NativeReadResultSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    }),
  ),
  details: Schema.optionalKey(Schema.Unknown),
});

/**
 * Guest tool inputs are closed. Root parse options also reach nested structs, so an unknown key
 * at any depth fails decoding before dispatch instead of being stripped into a different request.
 * Diagnostics name the key but not its value. Only inputs are closed; native results stay tolerant.
 */
export const CLOSED_GUEST_INPUT = { parseOptions: { onExcessProperty: "error" } } as const;

export const ReadGuestInputSchema = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(PositiveSafeInteger),
  limit: Schema.optionalKey(PositiveSafeInteger),
  format: Schema.optionalKey(Schema.Literals(["text", "structured"])),
  requireComplete: Schema.optionalKey(Schema.Boolean),
}).annotate(CLOSED_GUEST_INPUT);

export const StructuredReadResultSchema = Schema.Struct({
  text: Schema.String,
  completeness: Schema.Literals(["complete", "partial", "unknown"]),
  reason: Schema.optionalKey(
    Schema.Literals(["offset", "native-truncation", "limited-read", "metadata-unavailable"]),
  ),
  truncatedBy: Schema.optionalKey(Schema.Literals(["lines", "bytes"])),
  nextOffset: Schema.optionalKey(PositiveSafeInteger),
});

export type StructuredReadResult = typeof StructuredReadResultSchema.Type;
export type ReadCompleteness = Omit<StructuredReadResult, "text">;
export type ReadGuestData = string | StructuredReadResult;

export type ReadGuestInput = typeof ReadGuestInputSchema.Type;

const decodeNativeReadResult = Schema.decodeUnknownEffect(NativeReadResultSchema);

export const decodeReadGuestInput = <Input>(input: Input): ReadGuestInput | undefined =>
  decodeOption(ReadGuestInputSchema, input);

const nativeTruncation = <Details>(details: Details) => {
  const truncation = decodeOption(NativeReadDetailsSchema, details)?.truncation;
  if (
    truncation === undefined ||
    !truncation.truncated ||
    truncation.truncatedBy === null ||
    truncation.outputLines > truncation.totalLines ||
    truncation.outputBytes > truncation.totalBytes ||
    new TextEncoder().encode(truncation.content).byteLength !== truncation.outputBytes ||
    (truncation.outputLines === 0
      ? truncation.content !== ""
      : truncation.content.split("\n").length !== truncation.outputLines)
  )
    return undefined;
  return truncation;
};

const continuationOffset = (
  input: Pick<ReadGuestInput, "offset">,
  truncation: typeof NativeReadTruncationSchema.Type,
): number | undefined => {
  if (truncation.outputLines <= 0 || truncation.firstLineExceedsLimit || truncation.lastLinePartial)
    return undefined;
  const start = input.offset ?? 1;
  return truncation.outputLines <= Number.MAX_SAFE_INTEGER - start
    ? start + truncation.outputLines
    : undefined;
};

const isImageDiagnostic = (text: string): boolean => text.startsWith("Read image file [");

/**
 * Projects only the completeness facts Pi 0.86's native read result can prove. The claim concerns
 * one UTF-8-decoded native read, not byte fidelity, a stable filesystem snapshot, or atomicity.
 */
export const projectReadCompleteness = <Details>(
  input: Pick<ReadGuestInput, "offset" | "limit">,
  text: string,
  details: Details,
): ReadCompleteness => {
  if (isImageDiagnostic(text)) {
    return { completeness: "unknown", reason: "metadata-unavailable" };
  }

  const truncation = details === undefined ? undefined : nativeTruncation(details);
  if (details !== undefined && truncation === undefined) {
    return { completeness: "unknown", reason: "metadata-unavailable" };
  }
  const nextOffset = truncation === undefined ? undefined : continuationOffset(input, truncation);
  const nativeFields = truncation?.truncatedBy && {
    truncatedBy: truncation.truncatedBy,
    ...(nextOffset !== undefined && { nextOffset }),
  };

  if (input.offset !== undefined && input.offset > 1) {
    return { completeness: "partial", reason: "offset", ...nativeFields };
  }
  if (truncation !== undefined) {
    return { completeness: "partial", reason: "native-truncation", ...nativeFields };
  }
  if (input.limit !== undefined) {
    return { completeness: "unknown", reason: "limited-read" };
  }
  return { completeness: "complete" };
};

export const REQUIRE_COMPLETE_INPUT_REFUSAL =
  "Nested tool 'read' was not sent: requireComplete needs a whole-file request. Omit limit and use offset=1 or omit offset.";

export const requireCompleteInputRefusal = (input: ReadGuestInput): string | undefined =>
  input.requireComplete === true &&
  ((input.offset !== undefined && input.offset > 1) || input.limit !== undefined)
    ? REQUIRE_COMPLETE_INPUT_REFUSAL
    : undefined;

const requireCompleteResultRefusal = (projection: ReadCompleteness): string =>
  `Nested tool 'read' completed, but requireComplete refused its output because whole-file ` +
  `completeness was not proven (${projection.reason ?? "metadata-unavailable"}). No follow-up read was attempted.`;

/** Converts a settled native read result without rewriting its text or parsing continuation notes. */
export const readResultToGuestData = <Result>(
  input: ReadGuestInput,
  result: Result,
): Effect.Effect<ReadGuestData, ToolError> =>
  decodeNativeReadResult(result).pipe(
    Effect.mapError(() => toolError("Nested tool 'read' returned an unrecognized result shape.")),
    Effect.flatMap((decoded) => {
      const nonText = decoded.content.find((block) => block.type !== "text");
      if (nonText !== undefined) {
        return Effect.fail(
          toolError(
            `Nested tool 'read' returned ${nonText.type} content, which cannot enter a ` +
              "Code Mode program. Call the top-level read tool for that path instead.",
          ),
        );
      }
      const text = decoded.content.map((block) => block.text ?? "").join("\n");
      // Native text reads produce exactly one text block, including text: "" for empty files.
      // Preserve legacy string conversion, but never treat missing text as proof of completeness.
      const projection: ReadCompleteness =
        decoded.content.length === 1 && Predicate.isString(decoded.content[0]?.text)
          ? projectReadCompleteness(input, text, decoded.details)
          : { completeness: "unknown", reason: "metadata-unavailable" };
      if (input.requireComplete === true && projection.completeness !== "complete") {
        return Effect.fail(toolError(requireCompleteResultRefusal(projection)));
      }
      return Effect.succeed(input.format === "structured" ? { text, ...projection } : text);
    }),
  );
