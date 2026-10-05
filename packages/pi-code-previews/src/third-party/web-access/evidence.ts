import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";
import type { WebAccessTool } from "./identity";

const Text = Schema.String.check(Schema.isMaxLength(8192));
const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Texts = Schema.Array(Text).check(Schema.isMaxLength(32));
const Field = Schema.Union([Text, Schema.Number, Schema.Boolean, Schema.Null, Texts]);
const Arguments = Schema.Struct({
  query: Schema.optionalKey(Text),
  queries: Schema.optionalKey(Texts),
  claim: Schema.optionalKey(Text),
  url: Schema.optionalKey(Text),
  urls: Schema.optionalKey(Texts),
});
const Details = Schema.Struct({
  error: Schema.optionalKey(Text),
  cancelled: Schema.optionalKey(Schema.Boolean),
  browserOpenError: Schema.optionalKey(Text),
  phase: Schema.optionalKey(Text),
  queryCount: Schema.optionalKey(Count),
  successfulQueries: Schema.optionalKey(Count),
  totalResults: Schema.optionalKey(Count),
  urlCount: Schema.optionalKey(Count),
  successful: Schema.optionalKey(Count),
  totalChars: Schema.optionalKey(Count),
  sourceCount: Schema.optionalKey(Count),
  passageCount: Schema.optionalKey(Count),
  searchCount: Schema.optionalKey(Count),
  contentLength: Schema.optionalKey(Count),
  returnedChars: Schema.optionalKey(Count),
  offset: Schema.optionalKey(Count),
  nextOffset: Schema.optionalKey(Schema.NullOr(Count)),
  matchCount: Schema.optionalKey(Count),
  returnedMatches: Schema.optionalKey(Count),
  truncated: Schema.optionalKey(Schema.Boolean),
  responseId: Schema.optionalKey(Text),
  searchId: Schema.optionalKey(Text),
  enabled: Schema.optionalKey(Texts),
  missing: Schema.optionalKey(Texts),
  unavailable: Schema.optionalKey(Texts),
});

/** Schema sees copied data slots, never an array accessor supplied by the provider. */
function arraySnapshot<Value>(value: Value[]): Value[] | undefined {
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) return undefined;
  const copied: Value[] = [];
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !("value" in entry)) return undefined;
    copied.push(entry.value);
  }
  return copied;
}

/** Materialize only fixed own data fields; never invoke provider getters or scan unknown keys. */
function snapshot<Value, Key extends string>(
  value: Value,
  fields: readonly Key[],
): Partial<Record<Key, typeof Field.Type>> | undefined {
  if (!Predicate.isObject(value) || Array.isArray(value)) return undefined;
  const input: Partial<Record<Key, typeof Field.Type>> = {};
  for (const key of fields) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field) continue;
    if (!("value" in field)) return undefined;
    if (field.value === undefined) continue;
    const raw = Array.isArray(field.value) ? arraySnapshot(field.value) : field.value;
    const decoded = decodeUnknownOrUndefined(Field, raw);
    if (decoded === undefined) return undefined;
    input[key] = decoded;
  }
  return input;
}

export function webAccessSubject<Args>(name: WebAccessTool, args: Args): string {
  return invokeHostCallback(() => {
    const input = snapshot(args, Object.keys(Arguments.fields));
    const fields = input && decodeUnknownOrUndefined(Arguments, input);
    if (!fields) return "";
    if (name === "web_enable") return "enable";
    if (name === "source_check") return fields.claim ?? "";
    if (name === "web_search") return fields.queries?.join("; ") || fields.query || "";
    return fields.urls?.join("; ") || fields.url || fields.query || "stored result";
  }, "");
}

/** Stored-page results may omit their reference; the exact request retains it. */
export function webAccessArgumentReference<Args>(args: Args): string {
  return invokeHostCallback(() => {
    const input = snapshot(args, ["responseId"]);
    return decodeUnknownOrUndefined(Text, input?.responseId)?.trim() ?? "";
  }, "");
}

export interface WebAccessEvidence {
  readonly details: typeof Details.Type;
  readonly researchErrors: number;
}

/** Count only bounded research errors supplied in the result, never read stored artifacts. */
function researchErrors<Artifact>(value: Artifact): number | undefined {
  if (!Predicate.isObject(value) || Array.isArray(value)) return undefined;
  let count = 0;
  for (const key of ["errors", "sources"] as const) {
    const fieldDescriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!fieldDescriptor) continue;
    if (!("value" in fieldDescriptor)) return undefined;
    if (fieldDescriptor.value === undefined) continue;
    if (!Array.isArray(fieldDescriptor.value)) return undefined;
    const array = arraySnapshot(fieldDescriptor.value);
    if (!array) return undefined;
    for (const entry of array) {
      const field = key === "errors" ? "error" : "fetch_error";
      const record = snapshot(entry, [field]);
      if (!record) return undefined;
      if (record[field] === undefined && key === "sources") continue;
      const error = decodeUnknownOrUndefined(Text, record[field]);
      if (error === undefined) return undefined;
      if (error.trim()) count++;
    }
  }
  return count;
}

/** A small compatibility projection, not an authoritative provider outcome or claim verdict. */
export function webAccessEvidence<Details>(
  name: WebAccessTool,
  value: Details,
): WebAccessEvidence | undefined {
  return invokeHostCallback(() => {
    const input = snapshot(value, Object.keys(Details.fields));
    const details = input && decodeUnknownOrUndefined(Details, input);
    if (!details) return undefined;
    if (
      (details.successfulQueries !== undefined &&
        (details.queryCount === undefined || details.successfulQueries > details.queryCount)) ||
      (details.successful !== undefined &&
        (details.urlCount === undefined || details.successful > details.urlCount)) ||
      (details.returnedMatches !== undefined &&
        (details.matchCount === undefined || details.returnedMatches > details.matchCount)) ||
      (details.returnedChars !== undefined &&
        details.contentLength !== undefined &&
        (details.offset ?? 0) + details.returnedChars > details.contentLength)
    )
      return undefined;
    let errors = 0;
    if (name === "source_check") {
      if (!Predicate.isObject(value)) return undefined;
      const artifact = Object.getOwnPropertyDescriptor(value, "artifact");
      if (artifact && !("value" in artifact)) return undefined;
      if (artifact?.value !== undefined) {
        const counted = researchErrors(artifact.value);
        if (counted === undefined) return undefined;
        errors = counted;
      }
    }
    return { details, researchErrors: errors };
  }, undefined);
}
