import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { invokeHostCallback } from "pi-cosmic-core/host-session";

const NonNegativeFiniteNumberSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

const AssistantUsageSchema = Schema.Struct({
  input: NonNegativeFiniteNumberSchema,
  output: NonNegativeFiniteNumberSchema,
  cacheRead: NonNegativeFiniteNumberSchema,
  cacheWrite: NonNegativeFiniteNumberSchema,
  cost: Schema.Struct({ total: NonNegativeFiniteNumberSchema }),
});

const CompletedAssistantOutputSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  stopReason: Schema.Literals(["stop", "toolUse", "length"]),
  usage: Schema.Struct({ output: Schema.Int.check(Schema.isGreaterThan(0)) }),
});

const FooterTotalsSchema = Schema.Struct({
  ...AssistantUsageSchema.fields,
  cost: NonNegativeFiniteNumberSchema,
});

const ContextUsageSchema = Schema.Struct({
  tokens: Schema.NullOr(NonNegativeFiniteNumberSchema),
  contextWindow: NonNegativeFiniteNumberSchema,
  percent: Schema.NullOr(NonNegativeFiniteNumberSchema),
});

export type FooterTotals = typeof FooterTotalsSchema.Type;
export type DecodedAssistantUsage = typeof AssistantUsageSchema.Type;
export type DecodedContextUsage = typeof ContextUsageSchema.Type;

export const decodeAssistantUsage = decodeUnknownOrUndefined(AssistantUsageSchema);

export const decodeCompletedAssistantOutput = Fn.flow(
  decodeUnknownOrUndefined(CompletedAssistantOutputSchema),
  (completed) => completed?.usage.output,
);

/** Sums of decoded non-negative usage stay non-negative; only overflow can make them invalid. */
export const addAssistantUsage = (
  totals: FooterTotals,
  usage: DecodedAssistantUsage,
): FooterTotals | undefined => {
  const next = {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + usage.cost.total,
  };
  return Number.isFinite(next.input) &&
    Number.isFinite(next.output) &&
    Number.isFinite(next.cacheRead) &&
    Number.isFinite(next.cacheWrite) &&
    Number.isFinite(next.cost)
    ? next
    : undefined;
};

export const decodeContextUsage = decodeUnknownOrUndefined(ContextUsageSchema);

export const decodeHostCount = decodeUnknownOrUndefined(NonNegativeFiniteNumberSchema);

export const emptyTotals = (): FooterTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

/** Usage an entry persists; assistant and usage entries must carry it, others may. */
const persistedUsage = (entry: SessionEntry) => {
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")
    return { required: entry.type === "usage", usage: entry.usage };
  if (entry.type === "message" && entry.message.role === "assistant")
    return { required: true, usage: entry.message.usage };
  if (entry.type === "message" && entry.message.role === "toolResult")
    return { required: false, usage: entry.message.usage };
  return { required: false, usage: undefined };
};

/**
 * Reads session totals from persisted usage, or undefined when the session can't be read or an
 * entry holds unreadable usage, so a partial sum never replaces complete totals.
 *
 * The session is append-only, so each read folds only entries added since the last complete read.
 * A shorter session, or one whose last folded entry moved, was replaced (new, resumed, or branched)
 * and is folded again from its start.
 */
export const createSessionUsageReader = (sessionManager: ExtensionContext["sessionManager"]) => {
  let folded = 0;
  let lastFolded: SessionEntry | undefined;
  let foldedTotals = emptyTotals();
  return (): FooterTotals | undefined =>
    invokeHostCallback<FooterTotals | undefined>(() => {
      const entries = sessionManager.getEntries();
      const resumes =
        folded <= entries.length && (folded === 0 || entries[folded - 1] === lastFolded);
      let totals = resumes ? foldedTotals : emptyTotals();
      for (let index = resumes ? folded : 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry === undefined) return undefined;
        const { required, usage: rawUsage } = persistedUsage(entry);
        if (rawUsage === undefined && !required) continue;
        const usage = decodeAssistantUsage(rawUsage);
        const next = usage && addAssistantUsage(totals, usage);
        if (next === undefined) return undefined;
        totals = next;
      }
      folded = entries.length;
      lastFolded = entries.at(-1);
      foldedTotals = totals;
      return totals;
    }, undefined);
};

export const readSessionUsageTotals = (
  sessionManager: ExtensionContext["sessionManager"],
): FooterTotals | undefined => createSessionUsageReader(sessionManager)();
