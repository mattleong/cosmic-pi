/** Validate current and historical ledgers together, retaining salvage on contradictions. */
import { invocationIssues } from "../tools/issue-evidence.ts";
import {
  CompactAttentionSchema,
  recoverCompactNotices,
  type CompactAttention,
} from "../tools/compact-evidence.ts";
import {
  McpEvidenceSchema,
  validMcpCoverage,
  isCompactPiTool,
  type McpEvidence,
} from "../tools/mcp-evidence.ts";
import { decodeOption, type CodeModeCallEntry, type CodeModeCallCounts } from "../tools/format.ts";

/** Historical MCP-only rows need full call coverage; current ledgers retain explicit incompleteness. */
export const replayCompactEligible = (
  record: { mcpEvidence?: unknown },
  toolCalls: readonly CodeModeCallEntry[],
  total: number,
  mcpEvidence: McpEvidence | undefined,
  compactAttention: CompactAttention | undefined,
): boolean =>
  compactAttention !== undefined ||
  record.mcpEvidence === undefined ||
  (mcpEvidence !== undefined &&
    validMcpCoverage(mcpEvidence, total) &&
    toolCalls.filter((call) => isCompactPiTool(call.tool)).length <= mcpEvidence.pi &&
    toolCalls.filter((call) => call.tool === "mcp.request").length <= mcpEvidence.mcp &&
    toolCalls.every((call) => isCompactPiTool(call.tool) || call.tool === "mcp.request"));

/** Compare aggregate operation outcomes with retained rows and lifecycle settlement. */
const attentionContradictsRows = (
  decodedAttention: CompactAttention | undefined,
  toolCalls: readonly CodeModeCallEntry[],
  counts: CodeModeCallCounts,
): boolean => {
  const total = counts.total;
  const visibleOutcomes = { errors: 0, warnings: 0, cancelled: 0, uncertain: 0 };
  for (const call of toolCalls) {
    const outcome = call.compact?.outcome;
    if (outcome === "error") visibleOutcomes.errors++;
    else if (outcome === "warning") visibleOutcomes.warnings++;
    else if (outcome === "cancelled") visibleOutcomes.cancelled++;
    else if (outcome === "uncertain") visibleOutcomes.uncertain++;
  }
  const invalidAttention =
    decodedAttention !== undefined &&
    (decodedAttention.errors < visibleOutcomes.errors ||
      decodedAttention.warnings < visibleOutcomes.warnings ||
      decodedAttention.cancelled < visibleOutcomes.cancelled ||
      decodedAttention.uncertain < visibleOutcomes.uncertain ||
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

export const reconcileReplayEvidence = (
  record: { mcpEvidence?: unknown; compactAttention?: unknown },
  toolCalls: readonly CodeModeCallEntry[],
  counts: CodeModeCallCounts,
  malformedReceipt: boolean,
) => {
  const total = counts.total;
  const mcpEvidence = decodeOption(McpEvidenceSchema, record.mcpEvidence);
  const rawAttention = decodeOption(CompactAttentionSchema, record.compactAttention);
  const decodedAttention =
    rawAttention?.version === 2
      ? {
          ...rawAttention,
          issues: invocationIssues(rawAttention.issues) ?? {
            coverage: "unknown" as const,
            entries: [],
          },
        }
      : rawAttention;
  const invalidAttention = attentionContradictsRows(decodedAttention, toolCalls, counts);
  const malformedMcp =
    record.mcpEvidence !== undefined &&
    (mcpEvidence === undefined ||
      mcpEvidence.incomplete ||
      (counts.running + counts.queued === 0 && mcpEvidence.observed !== mcpEvidence.mcp) ||
      !validMcpCoverage(
        { ...mcpEvidence, unsupported: 0, pi: mcpEvidence.pi + mcpEvidence.unsupported },
        total,
      ));
  const compactAttention =
    malformedReceipt ||
    (record.compactAttention !== undefined && malformedMcp) ||
    invalidAttention ||
    (record.compactAttention !== undefined && decodedAttention === undefined)
      ? {
          ...(decodedAttention ?? {
            version: 1 as const,
            admitted: total,
            started: 0,
            unsupported: 0,
            observed: 0,
            errors: 0,
            warnings: 0,
            cancelled: 0,
            uncertain: 0,
            notices: recoverCompactNotices(record.compactAttention),
          }),
          incomplete: true,
        }
      : decodedAttention;
  return { mcpEvidence, compactAttention };
};
