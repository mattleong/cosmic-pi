import type { RunRecord } from "./internal.ts";
import { emptyUsage, isTerminalRunState, type SubagentUsage } from "./model.ts";
import { addUsage } from "./state.ts";

/**
 * The session's known subagent usage: what earlier runtimes of this session recorded, runs this
 * runtime already evicted, and current runs. It also remembers how much of each current run's
 * usage the session record already holds. The service owns the only instance, under the run lock.
 */
export interface SessionUsageLedger {
  readonly restored: SubagentUsage;
  retired: SubagentUsage;
  readonly recorded: WeakMap<RunRecord, SubagentUsage>;
}

export const emptySessionUsageLedger = (
  restored: SubagentUsage = emptyUsage(),
): SessionUsageLedger => ({ restored, retired: emptyUsage(), recorded: new WeakMap() });

const withoutContext = (usage: SubagentUsage): SubagentUsage => {
  const { contextPercent: _context, ...counted } = usage;
  return counted;
};

export const retireRunUsageLocked = (ledger: SessionUsageLedger, record: RunRecord): void => {
  ledger.retired = addUsage(ledger.retired, withoutContext(record.view.usage));
};

export const sessionUsageLocked = (
  ledger: SessionUsageLedger,
  records: ReadonlyMap<string, RunRecord>,
): SubagentUsage => {
  let total = addUsage(ledger.restored, ledger.retired);
  for (const record of records.values()) total = addUsage(total, withoutContext(record.view.usage));
  return total;
};

/** What the session's subagents have spent, once that reaches `spendLimit`. */
export const spentAtLimitLocked = (
  ledger: SessionUsageLedger,
  records: ReadonlyMap<string, RunRecord>,
  spendLimit: number | undefined,
): number | undefined => {
  if (spendLimit === undefined) return undefined;
  const spent = sessionUsageLocked(ledger, records).cost ?? 0;
  return spent >= spendLimit ? spent : undefined;
};

const usageSince = (current: SubagentUsage, recorded: SubagentUsage): SubagentUsage => {
  const cost = current.cost === undefined ? undefined : current.cost - (recorded.cost ?? 0);
  return {
    input: current.input - recorded.input,
    output: current.output - recorded.output,
    cacheRead: current.cacheRead - recorded.cacheRead,
    cacheWrite: current.cacheWrite - recorded.cacheWrite,
    totalTokens: current.totalTokens - recorded.totalTokens,
    ...(cost !== undefined && { cost }),
  };
};

const isEmptyUsage = (usage: SubagentUsage): boolean =>
  usage.input === 0 &&
  usage.output === 0 &&
  usage.cacheRead === 0 &&
  usage.cacheWrite === 0 &&
  usage.totalTokens === 0 &&
  (usage.cost ?? 0) === 0;

/**
 * Takes the usage each run gained since the session record last saw it. Unless `includeActive`,
 * only runs whose assignment has settled are taken, so the record grows once per assignment
 * instead of once per child turn.
 */
export const takeUnrecordedUsageLocked = (
  ledger: SessionUsageLedger,
  records: Iterable<RunRecord>,
  includeActive = false,
): ReadonlyArray<SubagentUsage> => {
  const taken: SubagentUsage[] = [];
  for (const record of records) {
    const { state, usage } = record.view;
    if (!includeActive && !isTerminalRunState(state) && state !== "paused") continue;
    const delta = usageSince(usage, ledger.recorded.get(record) ?? emptyUsage());
    if (isEmptyUsage(delta)) continue;
    ledger.recorded.set(record, withoutContext(usage));
    taken.push(delta);
  }
  return taken;
};
