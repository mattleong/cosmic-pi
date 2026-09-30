import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";

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
const fields = ["id", "name", "args", "status", "durationMs", "error", "cost"] as const;
const FieldValue = Schema.Union([Text, Nonnegative, Schema.Undefined]);
type CallInput = Partial<Record<(typeof fields)[number], typeof FieldValue.Type>>;
interface NativeRecovery {
  fullOutputPath?: string;
}
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

function ownDescriptor<Value>(value: Value, key: string): PropertyDescriptor | undefined {
  return invokeHostCallback(() => Object.getOwnPropertyDescriptor(value, key), undefined);
}

function callRecord<Value>(value: Value): NativeCodemodeCall | undefined {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(value) || Array.isArray(value)) return undefined;
    const input: CallInput = {};
    for (const key of fields) {
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
  const unavailable: NativeCallEvidence = { kind: "unavailable" };
  return invokeHostCallback(() => {
    if (!Predicate.isObject(value) || Array.isArray(value)) return unavailable;
    const fullOutputPath = decodeUnknownOrUndefined(
      Text,
      ownDescriptor(value, "fullOutputPath")?.value,
    );
    const recovery: NativeRecovery = {};
    if (fullOutputPath?.trim()) recovery.fullOutputPath = fullOutputPath;
    const records = ownDescriptor(value, "calls")?.value;
    if (!invokeHostCallback(() => Array.isArray(records), false))
      return { ...unavailable, ...recovery };
    const recordCount = decodeUnknownOrUndefined(
      Schema.Natural,
      ownDescriptor(records, "length")?.value,
    );
    if (recordCount === undefined) return { ...unavailable, ...recovery };
    const inspected = Math.min(recordCount, MAX_CALL_RECORDS);
    const calls: NativeCodemodeCall[] = [];
    for (let index = recordCount - inspected; index < recordCount; index++) {
      const call = invokeHostCallback(
        () => callRecord(ownDescriptor(records, String(index))?.value),
        undefined,
      );
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
  }, unavailable);
}

/** Coverage is expanded-only diagnostics; incomplete metadata never becomes a dispatch total. */
export function nativeEvidenceCoverage(evidence: NativeCallEvidence): string {
  if (evidence.kind === "unavailable") return "No readable call ledger is available";
  return `${evidence.calls.length} validated records; ${evidence.inspected} of ${evidence.recordCount} records inspected; ${evidence.rejected} inspected records unavailable; ${evidence.uninspected} older records not inspected`;
}
