import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";
import { ownData } from "./native-safe-content";

const Text = Schema.String.check(Schema.isMaxLength(4096));
const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Call = Schema.Struct({
  id: Text,
  name: Text,
  args: Text,
  status: Schema.Literals(["running", "ok", "error", "cancelled"]),
  durationMs: Schema.optionalKey(Nonnegative),
  error: Schema.optionalKey(Text),
  cost: Schema.optionalKey(Nonnegative),
});
export type NativeCodemodeCall = typeof Call.Type;
const FieldValue = Schema.Union([Text, Nonnegative, Schema.Undefined]);
const MAX_CALL_RECORDS = 256;

export type NativeCallEvidence = (
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly calls: readonly NativeCodemodeCall[];
      /** Received metadata slots, not an asserted count of validated dispatches. */
      readonly recordCount: number;
      readonly inspected: number;
      readonly rejected: number;
      readonly uninspected: number;
      readonly complete: boolean;
    }
) & { readonly fullOutputPath?: string };

/** One record from its fixed own data fields; any accessor or invalid field rejects it. */
function callRecord<Value>(value: Value): NativeCodemodeCall | undefined {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(value)) return undefined;
    const input: Partial<Record<string, typeof FieldValue.Type>> = {};
    for (const key of Object.keys(Call.fields)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!("value" in descriptor)) return undefined;
      const decoded = decodeUnknownOrUndefined(FieldValue, descriptor.value);
      if (decoded === undefined && descriptor.value !== undefined) return undefined;
      input[key] = decoded;
    }
    return decodeUnknownOrUndefined(Call, input);
  }, undefined);
}

/** Inspect only fixed own fields and the latest 256 slots; no getters, whole-ledger scan or repair. */
export function nativeCodemodeEvidence<Value>(value: Value): NativeCallEvidence {
  const fullOutputPath = ownData(value, "fullOutputPath", Text);
  const recovery = fullOutputPath?.trim() ? { fullOutputPath } : {};
  const records = ownData(value, "calls", Schema.Unknown);
  if (!invokeHostCallback(() => Array.isArray(records), false))
    return { kind: "unavailable", ...recovery };
  const recordCount = ownData(records, "length", Schema.Natural);
  if (recordCount === undefined) return { kind: "unavailable", ...recovery };
  const inspected = Math.min(recordCount, MAX_CALL_RECORDS);
  const calls: NativeCodemodeCall[] = [];
  for (let index = recordCount - inspected; index < recordCount; index++) {
    const call = callRecord(ownData(records, String(index), Schema.Unknown));
    if (call) calls.push(call);
  }
  const rejected = inspected - calls.length;
  const uninspected = recordCount - inspected;
  return {
    kind: "available",
    calls,
    recordCount,
    inspected,
    rejected,
    uninspected,
    complete: rejected === 0 && uninspected === 0,
    ...recovery,
  };
}

/** Coverage is expanded-only diagnostics; incomplete metadata never becomes a dispatch total. */
export function nativeEvidenceCoverage(evidence: NativeCallEvidence): string {
  if (evidence.kind === "unavailable") return "No readable call ledger is available";
  return `${evidence.calls.length} validated records; ${evidence.inspected} of ${evidence.recordCount} records inspected; ${evidence.rejected} inspected records unavailable; ${evidence.uninspected} older records not inspected`;
}
