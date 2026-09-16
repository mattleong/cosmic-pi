/** Historical MCP evidence decoding only. New executions use producer receipts and generic attention. */
import * as Schema from "effect/Schema";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const isCompactPiTool = (name: string): boolean =>
  [
    "pi.read",
    "pi.bash",
    "pi.powershell",
    "pi.edit",
    "pi.write",
    "pi.grep",
    "pi.find",
    "pi.ls",
  ].includes(name);
const Notice = Schema.String.check(Schema.isMaxLength(512));
const Notices = Schema.Array(Notice).check(Schema.isMaxLength(32));
export const McpEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  pi: Count,
  mcp: Count,
  unsupported: Count,
  observed: Count,
  completed: Count,
  errors: Count,
  unknown: Count,
  notSent: Count,
  incomplete: Schema.Boolean,
  notices: Notices,
});
export type McpEvidence = typeof McpEvidenceSchema.Type;
export const copyMcpEvidence = (evidence: McpEvidence): McpEvidence =>
  Object.freeze({ ...evidence, notices: Object.freeze([...evidence.notices]) });

/** Historical attention remains visible even when incomplete coverage declines compaction. */
export const mcpAttention = (evidence: McpEvidence | undefined): readonly string[] => {
  if (evidence === undefined) return [];
  return [
    ...evidence.notices,
    ...(evidence.incomplete
      ? [
          "MCP presentation evidence is incomplete or exceeded its warning limit. Some recovery information is unavailable; do not replay operations to recover output.",
        ]
      : []),
    ...(evidence.unknown > 0
      ? ["MCP execution is uncertain. Check its state; do not replay the operation automatically."]
      : []),
    ...(evidence.notSent > 0 ? [`${evidence.notSent} MCP operations were not sent.`] : []),
    ...(evidence.errors > 0
      ? [
          `${evidence.errors} MCP operations reported errors. Completed operations must not be replayed to recover output.`,
        ]
      : []),
  ];
};
export const validMcpCoverage = (evidence: McpEvidence, total: number): boolean =>
  Number.isSafeInteger(total) &&
  !evidence.incomplete &&
  evidence.unsupported === 0 &&
  evidence.pi + evidence.mcp + evidence.unsupported === total &&
  evidence.observed <= evidence.mcp &&
  evidence.completed + evidence.unknown + evidence.notSent === evidence.observed &&
  evidence.errors <= evidence.observed;
