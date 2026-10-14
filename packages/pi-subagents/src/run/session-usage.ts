import type { RunRecord } from "./internal.ts";
import { emptyUsage, type SubagentUsage } from "./model.ts";
import { addUsage } from "./state.ts";

/**
 * Usage of runs this session already evicted from the run registry, so the session total and
 * spend limit keep counting them. The service owns the only instance, under the run lock.
 */
export interface SessionUsageLedger {
  retired: SubagentUsage;
}

export const emptySessionUsageLedger = (): SessionUsageLedger => ({ retired: emptyUsage() });

export const retireRunUsageLocked = (ledger: SessionUsageLedger, record: RunRecord): void => {
  ledger.retired = addUsage(ledger.retired, { ...record.view.usage, contextPercent: undefined });
};

export const sessionUsageLocked = (
  ledger: SessionUsageLedger,
  records: ReadonlyMap<string, RunRecord>,
): SubagentUsage => {
  let total = ledger.retired;
  for (const record of records.values())
    total = addUsage(total, { ...record.view.usage, contextPercent: undefined });
  return total;
};
