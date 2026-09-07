import * as Schema from "effect/Schema";

import { createHash } from "node:crypto";
import {
  ADVISOR_FINDING_CATEGORIES,
  ADVISOR_FINDING_STATUSES,
  ADVISOR_SEVERITIES,
  advisorSeverityRank,
  type AdvisorFinding,
} from "./schema.ts";
import { canonicalAdvisorFindingFingerprint } from "./schema.ts";
import { isJsonObject } from "pi-cosmic-core";

export const MAX_FINDING_LIFECYCLE_RECORDS = 64;
const NonNegativeIntSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const AdvisorFindingRecordSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^af_[a-f\d]{32}$/)),
  key: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/)),
  generation: NonNegativeIntSchema,
  category: Schema.Literals(ADVISOR_FINDING_CATEGORIES),
  severity: Schema.Literals(ADVISOR_SEVERITIES),
  status: Schema.Literals(ADVISOR_FINDING_STATUSES),
  firstSeenTurn: NonNegativeIntSchema,
  lastSeenTurn: NonNegativeIntSchema,
}).check(
  Schema.makeFilter((record) => record.lastSeenTurn >= record.firstSeenTurn),
  Schema.makeFilter((record) => record.id === advisorFindingId(record.key, record.generation)),
);
export type AdvisorFindingRecord = Schema.Schema.Type<typeof AdvisorFindingRecordSchema>;
export interface AdvisorFindingLifecycleState {
  readonly records: readonly AdvisorFindingRecord[];
}
export const emptyAdvisorFindingLifecycle = (): AdvisorFindingLifecycleState => ({ records: [] });

export const restoreAdvisorFindingLifecycle = (
  records: readonly AdvisorFindingRecord[] | undefined,
): AdvisorFindingLifecycleState => ({
  records: (records?.slice(-MAX_FINDING_LIFECYCLE_RECORDS) ?? [])
    .filter(isValidAdvisorFindingRecord)
    .map((record) => ({ ...record })),
});
export const reconcileAdvisorFindings = (
  state: AdvisorFindingLifecycleState,
  findings: readonly AdvisorFinding[],
  options: { scope: string; completedTurn: number; complete: boolean },
) => {
  const records = new Map(state.records.map((record) => [record.id, { ...record }]));
  const generations = new Map<string, number>();
  for (const record of records.values())
    generations.set(record.key, Math.max(record.generation, generations.get(record.key) ?? 0));
  const active = new Set<string>();
  const enriched = findings.map((finding) => {
    const semantic = canonicalAdvisorFindingFingerprint(
      finding.fingerprint ?? `${finding.category} ${finding.issue} ${finding.recommendation}`,
    );
    const key = createHash("sha256").update(`${options.scope}\0${semantic}`).digest("hex");
    let generation = generations.get(key) ?? 0;
    let id = advisorFindingId(key, generation);
    const previous = records.get(id);
    if (previous?.status === "resolved" || previous?.status === "superseded") {
      generation += 1;
      generations.set(key, generation);
      id = advisorFindingId(key, generation);
    }
    const record = records.get(id) ?? {
      id,
      key,
      generation,
      category: finding.category,
      severity: finding.severity,
      status: "open" as const,
      firstSeenTurn: options.completedTurn,
      lastSeenTurn: options.completedTurn,
    };
    if (
      record.status === "acknowledged" &&
      advisorSeverityRank(finding.severity) > advisorSeverityRank(record.severity)
    )
      record.status = "open";
    record.category = finding.category;
    record.severity = finding.severity;
    record.lastSeenTurn = options.completedTurn;
    records.set(id, record);
    active.add(id);
    return { ...finding, id, status: record.status };
  });
  if (options.complete)
    for (const record of records.values()) {
      if (
        (record.status === "open" || record.status === "acknowledged") &&
        !active.has(record.id)
      ) {
        record.status = "resolved";
        record.lastSeenTurn = options.completedTurn;
      }
    }
  const retained = trimRecords([...records.values()]);
  return { state: { records: retained }, findings: enriched };
};
export const acknowledgeAdvisorFindings = (
  state: AdvisorFindingLifecycleState,
  ids: readonly string[],
): AdvisorFindingLifecycleState => {
  const selected = new Set(ids);
  return {
    records: state.records.map((record) =>
      selected.has(record.id) && record.status === "open"
        ? { ...record, status: "acknowledged" }
        : record,
    ),
  };
};
function trimRecords(records: AdvisorFindingRecord[]): AdvisorFindingRecord[] {
  if (records.length <= MAX_FINDING_LIFECYCLE_RECORDS) return records;
  const sorted = [...records].sort(
    (left, right) =>
      Number(isTerminal(right)) - Number(isTerminal(left)) ||
      left.lastSeenTurn - right.lastSeenTurn ||
      left.firstSeenTurn - right.firstSeenTurn ||
      left.id.localeCompare(right.id),
  );
  const evicted = new Set(
    sorted.slice(0, records.length - MAX_FINDING_LIFECYCLE_RECORDS).map((record) => record.id),
  );
  return records.filter((record) => !evicted.has(record.id));
}
export function isValidAdvisorFindingRecord<ValueInput>(
  value: ValueInput,
): value is ValueInput & AdvisorFindingRecord {
  return isJsonObject(value) && Schema.is(AdvisorFindingRecordSchema)(value);
}
function isTerminal(record: AdvisorFindingRecord): boolean {
  return record.status === "resolved" || record.status === "superseded";
}
export function advisorFindingId(key: string, generation: number): string {
  return `af_${createHash("sha256").update(`${key}\0${generation}`).digest("hex").slice(0, 32)}`;
}
