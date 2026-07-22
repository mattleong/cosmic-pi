import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stringifyJson } from "../boundary/json.ts";
import { isRecord } from "../shared/utils.ts";
import { parseAdvisorReview } from "../review/parse.ts";
import { redactSensitiveText } from "../review/observation-protocol.ts";
import { AdvisorModelError } from "./client.ts";
import {
  AdvisorCheckpointWireSchema,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  MAX_ADVISOR_CHECKPOINT_ID_CHARS,
  MAX_ADVISOR_STATE_SUMMARY_CHARS,
  type AdvisorCheckpoint,
} from "./types.ts";

export const decodeAdvisorCheckpoint = Effect.fn("AdvisorCheckpoint.decode")(function* (
  raw: string,
) {
  if (raw.length > MAX_ADVISOR_CHECKPOINT_CHARS) {
    return yield* new AdvisorModelError({
      message: "Advisor checkpoint exceeds the maximum response size.",
    });
  }
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AdvisorCheckpointWireSchema),
  )(raw.trim(), { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () => new AdvisorModelError({ message: "Advisor checkpoint failed schema validation." }),
    ),
  );
  return yield* Effect.try({
    try: () => diagnoseAdvisorCheckpoint(stringifyJson(decoded)),
    catch: (error) =>
      error instanceof AdvisorModelError
        ? error
        : new AdvisorModelError({ message: "Advisor checkpoint failed schema validation." }),
  });
});

export const parseAdvisorCheckpointEffect = (
  raw: string,
): Effect.Effect<AdvisorCheckpoint, AdvisorModelError> =>
  decodeAdvisorCheckpoint(raw).pipe(Effect.withSpan("pi-advisor.checkpoint.decode"));

/** Pure compatibility parser retained for deterministic parser tests. */
export function parseAdvisorCheckpoint(raw: string): AdvisorCheckpoint {
  if (raw.length > MAX_ADVISOR_CHECKPOINT_CHARS) {
    throw new AdvisorModelError({
      message: "Advisor checkpoint exceeds the maximum response size.",
    });
  }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(AdvisorCheckpointWireSchema), {
    onExcessProperty: "error",
  })(raw.trim());
  if (Option.isNone(decoded)) {
    diagnoseAdvisorCheckpoint(raw);
    throw new AdvisorModelError({ message: "Advisor checkpoint failed schema validation." });
  }
  return diagnoseAdvisorCheckpoint(stringifyJson(decoded.value));
}

function diagnoseAdvisorCheckpoint(raw: string): AdvisorCheckpoint {
  if (raw.length > MAX_ADVISOR_CHECKPOINT_CHARS) {
    throw new AdvisorModelError({
      message: "Advisor checkpoint exceeds the maximum response size.",
    });
  }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(raw.trim());
  if (Option.isNone(decoded))
    throw new AdvisorModelError({ message: "Advisor returned malformed checkpoint JSON." });
  const parsed = decoded.value;
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
  const review = parseAdvisorReview(
    stringifyJson({
      verdict: parsed.verdict,
      summary: parsed.summary,
      ...(parsed.suggestions !== undefined ? { suggestions: parsed.suggestions } : {}),
      findings: parsed.findings,
    }),
  );
  const checkpoint: AdvisorCheckpoint = {
    checkpointId: parsed.checkpointId,
    processedThrough: Number(parsed.processedThrough),
    stateSummary: redactSensitiveText(parsed.stateSummary),
    ...review,
  };
  if (Option.isNone(Schema.decodeUnknownOption(AdvisorCheckpointWireSchema)(checkpoint))) {
    throw new AdvisorModelError({ message: "Advisor checkpoint failed schema validation." });
  }
  return checkpoint;
}
