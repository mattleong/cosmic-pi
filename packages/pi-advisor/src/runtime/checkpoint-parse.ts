import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isRecord } from "../shared/utils.ts";
import { parseAdvisorReviewValue } from "../review/parse.ts";
import { AdvisorReviewParseError } from "../review/schema.ts";
import { redactSensitiveText } from "../domain/redaction.ts";
import { AdvisorModelError } from "./client.ts";
import {
  AdvisorCheckpointWireSchema,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  MAX_ADVISOR_CHECKPOINT_ID_CHARS,
  MAX_ADVISOR_STATE_SUMMARY_CHARS,
  type AdvisorCheckpoint,
} from "./types.ts";

/**
 * Checkpoint decoding.
 *
 * Like the review parser, this performs one wire gate plus one invariant assertion on the emitted
 * checkpoint. Granular diagnostics run on the value that failed the gate so exact-key, correlation,
 * and review-lane messages keep priority over the generic schema-validation message.
 */
export const decodeAdvisorCheckpoint = Effect.fn("AdvisorCheckpoint.decode")(function* (
  raw: string,
) {
  if (raw.length > MAX_ADVISOR_CHECKPOINT_CHARS) {
    return yield* new AdvisorModelError({
      message: "Advisor checkpoint exceeds the maximum response size.",
    });
  }
  return yield* Effect.try({
    try: () => parseCheckpointText(raw),
    catch: (error) =>
      error instanceof AdvisorModelError
        ? error
        : // Embedded review diagnostics keep their exact message inside the checkpoint error type.
          new AdvisorModelError({
            message:
              error instanceof AdvisorReviewParseError
                ? error.message
                : "Advisor checkpoint failed schema validation.",
          }),
  });
});

export const parseAdvisorCheckpointEffect = (
  raw: string,
): Effect.Effect<AdvisorCheckpoint, AdvisorModelError> =>
  decodeAdvisorCheckpoint(raw).pipe(Effect.withSpan("pi-advisor.checkpoint.decode"));

function parseCheckpointText(raw: string): AdvisorCheckpoint {
  const trimmed = raw.trim();
  const gated = Schema.decodeUnknownOption(Schema.fromJsonString(AdvisorCheckpointWireSchema), {
    onExcessProperty: "error",
  })(trimmed);
  if (Option.isSome(gated)) return finishCheckpoint(gated.value);
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(trimmed);
  if (Option.isNone(decoded))
    throw new AdvisorModelError({ message: "Advisor returned malformed checkpoint JSON." });
  normalizeCheckpoint(decoded.value);
  throw new AdvisorModelError({ message: "Advisor checkpoint failed schema validation." });
}

function finishCheckpoint(gated: unknown): AdvisorCheckpoint {
  const checkpoint = normalizeCheckpoint(gated);
  if (Option.isNone(Schema.decodeUnknownOption(AdvisorCheckpointWireSchema)(checkpoint))) {
    throw new AdvisorModelError({ message: "Advisor checkpoint failed schema validation." });
  }
  return checkpoint;
}

/** Granular correlation/exact-key diagnostics on an already-decoded JSON value. */
function normalizeCheckpoint(parsed: unknown): AdvisorCheckpoint {
  if (!isRecord(parsed))
    throw new AdvisorModelError({ message: "Advisor checkpoint must be an object." });
  const expected = [
    "checkpointId",
    "processedThrough",
    "stateSummary",
    "verdict",
    "summary",
    "suggestions",
    "findings",
  ].sort();
  const legacyExpected = expected.filter((key) => key !== "suggestions");
  const keys = Object.keys(parsed).sort();
  const exact =
    keys.length === expected.length && expected.every((key, index) => key === keys[index]);
  const legacy =
    keys.length === legacyExpected.length &&
    legacyExpected.every((key, index) => key === keys[index]);
  if (!exact && !legacy) {
    throw new AdvisorModelError({ message: "Advisor checkpoint fields are invalid." });
  }
  if (
    typeof parsed.checkpointId !== "string" ||
    !parsed.checkpointId ||
    parsed.checkpointId.length > MAX_ADVISOR_CHECKPOINT_ID_CHARS
  ) {
    throw new AdvisorModelError({ message: "Advisor checkpoint ID is invalid." });
  }
  if (!Number.isSafeInteger(parsed.processedThrough) || Number(parsed.processedThrough) < 0) {
    throw new AdvisorModelError({ message: "Advisor processedThrough is invalid." });
  }
  if (
    typeof parsed.stateSummary !== "string" ||
    parsed.stateSummary.length > MAX_ADVISOR_STATE_SUMMARY_CHARS
  ) {
    throw new AdvisorModelError({ message: "Advisor state summary is invalid or too large." });
  }
  const review = parseAdvisorReviewValue({
    verdict: parsed.verdict,
    summary: parsed.summary,
    ...(parsed.suggestions !== undefined ? { suggestions: parsed.suggestions } : {}),
    findings: parsed.findings,
  });
  return {
    checkpointId: parsed.checkpointId,
    processedThrough: Number(parsed.processedThrough),
    stateSummary: redactSensitiveText(parsed.stateSummary),
    ...review,
  };
}
