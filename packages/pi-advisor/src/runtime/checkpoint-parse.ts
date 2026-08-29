import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import { ADVISOR_REVIEW_SIZE_FILTER_IDENTIFIER } from "../review/schema.ts";
import { AdvisorModelError } from "./client.ts";
import {
  ADVISOR_STATE_SUMMARY_SIZE_FILTER_IDENTIFIER,
  AdvisorCheckpointSchema,
  AdvisorRuntimeResetRequiredError,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  type AdvisorCheckpoint,
} from "./types.ts";

const STRICT_CHECKPOINT_PARSE_OPTIONS = {
  onExcessProperty: "error",
  reportInput: false,
} as const satisfies SchemaAST.ParseOptions;
const RESPONSE_FORMAT_MESSAGE = "Advisor checkpoint response format is invalid.";
const RESET_REQUIRED_RESPONSE_FORMAT_MESSAGE =
  "Advisor checkpoint response format requires a fresh context.";
const MAX_INSPECTED_SCHEMA_ISSUES = 64;

const responseFormatError = (): AdvisorModelError =>
  new AdvisorModelError({ message: RESPONSE_FORMAT_MESSAGE, kind: "response-format" });
const resetRequiredResponseFormatError = (): AdvisorRuntimeResetRequiredError =>
  new AdvisorRuntimeResetRequiredError({
    message: RESET_REQUIRED_RESPONSE_FORMAT_MESSAGE,
    kind: "response-format",
  });

export const decodeAdvisorCheckpoint = Effect.fn("AdvisorCheckpoint.decode")(function* (
  raw: string,
) {
  if (raw.length > MAX_ADVISOR_CHECKPOINT_CHARS) {
    return yield* resetRequiredResponseFormatError();
  }
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AdvisorCheckpointSchema),
    STRICT_CHECKPOINT_PARSE_OPTIONS,
  )(raw).pipe(
    Effect.mapError((error) =>
      isResetRequiredSchemaFailure(error)
        ? resetRequiredResponseFormatError()
        : responseFormatError(),
    ),
  );
});

export const parseAdvisorCheckpointEffect = (
  raw: string,
): Effect.Effect<AdvisorCheckpoint, AdvisorModelError> =>
  decodeAdvisorCheckpoint(raw).pipe(Effect.withSpan("pi-advisor.checkpoint.decode"));

function isResetRequiredSchemaFailure(error: Schema.SchemaError): boolean {
  // JSON.parse rejection is the root JSON-string encoding with one direct InvalidValue issue.
  if (error.issue._tag === "Encoding" && error.issue.issue._tag === "InvalidValue") return true;
  return containsFilterIdentifier(
    error.issue,
    new Set([ADVISOR_REVIEW_SIZE_FILTER_IDENTIFIER, ADVISOR_STATE_SUMMARY_SIZE_FILTER_IDENTIFIER]),
  );
}

/** Bounded structural inspection only. Issues and their input never cross this function. */
function containsFilterIdentifier(
  root: SchemaIssue.Issue,
  identifiers: ReadonlySet<string>,
): boolean {
  const pending: SchemaIssue.Issue[] = [root];
  let inspected = 0;
  while (pending.length > 0 && inspected < MAX_INSPECTED_SCHEMA_ISSUES) {
    const issue = pending.pop()!;
    inspected += 1;
    switch (issue._tag) {
      case "Filter":
        if (identifiers.has(issue.filter.annotations?.identifier ?? "")) return true;
        pending.push(issue.issue);
        break;
      case "Encoding":
      case "Pointer":
        pending.push(issue.issue);
        break;
      case "Composite":
      case "AnyOf":
        for (let index = issue.issues.length - 1; index >= 0; index -= 1) {
          pending.push(issue.issues[index]!);
        }
        break;
    }
  }
  return false;
}
