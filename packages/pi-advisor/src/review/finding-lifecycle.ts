import * as Predicate from "effect/Predicate";

import { createHash } from "node:crypto";
import {
  ADVISOR_FINDING_CATEGORIES,
  ADVISOR_FINDING_STATUSES,
  ADVISOR_SEVERITIES,
  advisorSeverityRank,
  type AdvisorFinding,
  type AdvisorFindingCategory,
  type AdvisorFindingStatus,
  type AdvisorSeverity,
} from "./schema.ts";
import { canonicalAdvisorFindingFingerprint } from "./schema.ts";
import { isJsonObject } from "pi-cosmic-core";

export const MAX_FINDING_LIFECYCLE_RECORDS = 64;
export interface AdvisorFindingRecord {
  id: string;
  key: string;
  generation: number;
  category: AdvisorFindingCategory;
  severity: AdvisorSeverity;
  status: AdvisorFindingStatus;
  firstSeenTurn: number;
  lastSeenTurn: number;
}
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
export const supersedeAdvisorFindings = (
  state: AdvisorFindingLifecycleState,
  ids: readonly string[],
): AdvisorFindingLifecycleState => {
  const selected = new Set(ids);
  return {
    records: state.records.map((record) =>
      selected.has(record.id) && (record.status === "open" || record.status === "acknowledged")
        ? { ...record, status: "superseded" }
        : record,
    ),
  };
};
export const advisorFindingLifecycleCounts = (state: AdvisorFindingLifecycleState) => {
  const counts = { open: 0, acknowledged: 0, resolved: 0, superseded: 0 };
  for (const record of state.records) counts[record.status] += 1;
  return counts;
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
  if (!isJsonObject(value)) return false;
  return (
    Predicate.isString(value.id) &&
    /^af_[a-f\d]{32}$/.test(value.id) &&
    Predicate.isString(value.key) &&
    /^[a-f\d]{64}$/.test(value.key) &&
    Predicate.isNumber(value.generation) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    isOneOf(value.category, ADVISOR_FINDING_CATEGORIES) &&
    isOneOf(value.severity, ADVISOR_SEVERITIES) &&
    isOneOf(value.status, ADVISOR_FINDING_STATUSES) &&
    Predicate.isNumber(value.firstSeenTurn) &&
    Number.isSafeInteger(value.firstSeenTurn) &&
    value.firstSeenTurn >= 0 &&
    Predicate.isNumber(value.lastSeenTurn) &&
    Number.isSafeInteger(value.lastSeenTurn) &&
    value.lastSeenTurn >= value.firstSeenTurn &&
    value.id === advisorFindingId(value.key, value.generation)
  );
}
function isOneOf<const Values extends readonly unknown[], ValueInput>(
  value: ValueInput,
  values: Values,
): value is ValueInput & Values[number] {
  return values.includes(value);
}
function isTerminal(record: AdvisorFindingRecord): boolean {
  return record.status === "resolved" || record.status === "superseded";
}
export function advisorFindingId(key: string, generation: number): string {
  return `af_${createHash("sha256").update(`${key}\0${generation}`).digest("hex").slice(0, 32)}`;
}
