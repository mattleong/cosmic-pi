/** Validate the replayed ledger against retained rows, retaining salvage on contradictions. */
import { invocationIssues } from "../tools/issue-evidence.ts";
import {
  CompactAttentionSchema,
  recoverCompactNotices,
  type CompactAttention,
} from "../tools/compact-evidence.ts";
import { decodeOption, type CodeModeCallEntry, type CodeModeCallCounts } from "../tools/format.ts";

/** Compare aggregate operation outcomes with retained rows and lifecycle settlement. */
const attentionContradictsRows = (
  decodedAttention: CompactAttention | undefined,
  toolCalls: readonly CodeModeCallEntry[],
  counts: CodeModeCallCounts,
): boolean => {
  const total = counts.total;
  const visible = (outcome: string) =>
    toolCalls.filter((call) => call.compact?.outcome === outcome).length;
  const invalidAttention =
    decodedAttention !== undefined &&
    (decodedAttention.errors < visible("error") ||
      decodedAttention.warnings < visible("warning") ||
      decodedAttention.cancelled < visible("cancelled") ||
      decodedAttention.uncertain < visible("uncertain") ||
      decodedAttention.admitted !== total ||
      decodedAttention.started > total ||
      decodedAttention.observed > decodedAttention.started ||
      decodedAttention.errors +
        decodedAttention.warnings +
        decodedAttention.cancelled +
        decodedAttention.uncertain >
        decodedAttention.observed ||
      decodedAttention.unsupported > 0 ||
      (counts.running + counts.queued === 0 &&
        decodedAttention.started !== decodedAttention.observed) ||
      decodedAttention.observed < toolCalls.filter((call) => call.compact !== undefined).length);
  const missingReceipt =
    decodedAttention !== undefined &&
    toolCalls.some((call) => call.status === "completed" && call.compact === undefined);
  return invalidAttention || missingReceipt;
};

/**
 * Malformed evidence means incomplete. An undecodable ledger becomes a synthetic incomplete one
 * and its bounded valid notices are salvaged separately.
 */
export const reconcileReplayEvidence = (
  record: { compactAttention?: unknown },
  toolCalls: readonly CodeModeCallEntry[],
  counts: CodeModeCallCounts,
  malformedReceipt: boolean,
) => {
  const raw = decodeOption(CompactAttentionSchema, record.compactAttention);
  const decoded =
    raw === undefined
      ? undefined
      : {
          ...raw,
          issues: invocationIssues(raw.issues) ?? { coverage: "unknown" as const, entries: [] },
        };
  const valid =
    !malformedReceipt &&
    !attentionContradictsRows(decoded, toolCalls, counts) &&
    (record.compactAttention === undefined || decoded !== undefined);
  if (valid) return { compactAttention: decoded, salvaged: [] };
  if (decoded !== undefined)
    return { compactAttention: { ...decoded, incomplete: true }, salvaged: [] };
  const synthetic: CompactAttention = {
    version: 2,
    issues: { coverage: "unknown", entries: [] },
    admitted: counts.total,
    started: 0,
    unsupported: 0,
    observed: 0,
    errors: 0,
    warnings: 0,
    cancelled: 0,
    uncertain: 0,
    incomplete: true,
    notices: [],
  };
  return { compactAttention: synthetic, salvaged: recoverCompactNotices(record.compactAttention) };
};
