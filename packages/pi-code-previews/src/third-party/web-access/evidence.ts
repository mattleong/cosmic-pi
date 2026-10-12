import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";
import type { WebAccessTool } from "./identity";
import { nonEmptyText } from "../../shared/helpers";

const Text = Schema.String.check(Schema.isMaxLength(8192));
const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Texts = Schema.Array(Text).check(Schema.isMaxLength(32));
const Field = Schema.Union([Text, Schema.Finite, Schema.Boolean, Schema.Null, Texts]);
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

function arraySnapshot(value: readonly unknown[]): unknown[] | undefined {
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Predicate.isNumber(length) || !Number.isSafeInteger(length) || length < 0 || length > 256)
    return undefined;
  const copied: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !("value" in entry)) return undefined;
    const item: unknown = entry.value;
    copied.push(item);
  }
  return copied;
}

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
    const fieldValue: unknown = field.value;
    if (fieldValue === undefined) continue;
    const raw = Array.isArray(fieldValue) ? arraySnapshot(fieldValue) : fieldValue;
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
    if (name === "web_search")
      return nonEmptyText(fields.queries?.join("; ")) ?? nonEmptyText(fields.query) ?? "";
    return (
      nonEmptyText(fields.urls?.join("; ")) ??
      nonEmptyText(fields.url) ??
      nonEmptyText(fields.query) ??
      "stored result"
    );
  }, "");
}

export function webAccessArgumentReference<Args>(args: Args): string {
  return invokeHostCallback(() => {
    const input = snapshot(args, ["responseId"]);
    return decodeUnknownOrUndefined(Text, input?.responseId)?.trim() ?? "";
  }, "");
}

export type WebAccessDetails = typeof Details.Type;

interface WebAccessEvidence {
  readonly details: WebAccessDetails;
  readonly researchErrors: number;
}

function descriptorErrors(
  descriptor: PropertyDescriptor | undefined,
  field: "error" | "fetch_error",
  optional: boolean,
): number | undefined {
  if (!descriptor) return 0;
  if (!("value" in descriptor)) return undefined;
  if (descriptor.value === undefined) return 0;
  if (!Array.isArray(descriptor.value)) return undefined;
  const array = arraySnapshot(descriptor.value);
  if (!array) return undefined;
  let count = 0;
  for (const entry of array) {
    const record = snapshot(entry, [field]);
    if (!record) return undefined;
    if (record[field] === undefined && optional) continue;
    const error = decodeUnknownOrUndefined(Text, record[field]);
    if (error === undefined) return undefined;
    if (error.trim()) count++;
  }
  return count;
}

function researchErrors<Artifact>(value: Artifact): number | undefined {
  if (!Predicate.isObject(value) || Array.isArray(value)) return undefined;
  const errors = descriptorErrors(Object.getOwnPropertyDescriptor(value, "errors"), "error", false);
  if (errors === undefined) return undefined;
  const sources = descriptorErrors(
    Object.getOwnPropertyDescriptor(value, "sources"),
    "fetch_error",
    true,
  );
  return sources === undefined ? undefined : errors + sources;
}

const exceeds = (part: number | undefined, whole: number | undefined): boolean =>
  part !== undefined && (whole === undefined || part > whole);

function inconsistentCounts(details: WebAccessDetails): boolean {
  return (
    exceeds(details.successfulQueries, details.queryCount) ||
    exceeds(details.successful, details.urlCount) ||
    exceeds(details.returnedMatches, details.matchCount) ||
    (details.returnedChars !== undefined &&
      details.contentLength !== undefined &&
      (details.offset ?? 0) + details.returnedChars > details.contentLength)
  );
}

function artifactResearchErrors<Details>(value: Details): number | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const artifact = Object.getOwnPropertyDescriptor(value, "artifact");
  if (artifact && !("value" in artifact)) return undefined;
  return artifact?.value === undefined ? 0 : researchErrors(artifact.value);
}

export function webAccessEvidence<Details>(
  name: WebAccessTool,
  value: Details,
): WebAccessEvidence | undefined {
  return invokeHostCallback(() => {
    const input = snapshot(value, Object.keys(Details.fields));
    const details = input && decodeUnknownOrUndefined(Details, input);
    if (!details || inconsistentCounts(details)) return undefined;
    const errors = name === "source_check" ? artifactResearchErrors(value) : 0;
    return errors === undefined ? undefined : { details, researchErrors: errors };
  }, undefined);
}
