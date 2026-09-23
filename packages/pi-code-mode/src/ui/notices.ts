/** Shared evidence collection; each renderer retains ownership of notice selection. */
import { isCompactAttention, normalizeCompactIssues, type CompactNotice } from "pi-code-previews";
import { INCOMPLETE_ATTENTION } from "../tools/compact-evidence.ts";
import { mcpAttention } from "../tools/mcp-evidence.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

export const TRUNCATED_OUTPUT_NOTICE =
  "Output exceeded the output limit; prior operations may already have taken effect.";
const READ_ONLY_TRUNCATED_OUTPUT_NOTICE = "Output exceeded the output limit.";

/** Paging is routine only when current producer metadata proves the initial saved page. */
export const codeModeOutputNotice = (details: CodeModeRenderDetails): CompactNotice | undefined => {
  if (!details.truncated) return undefined;
  const preview = details.initialPreview;
  if (preview !== undefined)
    return {
      code: "initial-output-page",
      kind: "recovery",
      text:
        preview.next === null
          ? "Complete output returned in the initial saved-output page."
          : `Continue saved output with result.read id="${preview.id}" offset=${preview.next}.`,
      expandedOnly: true,
    };
  return {
    code: "output-truncated",
    kind: "recovery",
    text: details.receiptsReadOnly ? READ_ONLY_TRUNCATED_OUTPUT_NOTICE : TRUNCATED_OUTPUT_NOTICE,
  };
};

export const codeModeEvidenceNotices = (details: CodeModeRenderDetails): CompactNotice[] => {
  const notices: CompactNotice[] = [
    ...(details.receiptAttention ? [details.receiptAttention.notice] : []),
    ...(details.compactAttention?.version === 2
      ? normalizeCompactIssues([
          details.compactAttention.issues,
          ...details.toolCalls.flatMap((call) =>
            call.compact?.version === 2 ? [call.compact.issues] : [],
          ),
        ]).entries.flatMap((issue) => [
          ...(issue.cause
            ? [
                {
                  kind: issue.severity,
                  text: `${issue.operation}: ${issue.cause}`,
                  ...(issue.description !== undefined && { description: issue.description }),
                },
              ]
            : []),
          ...issue.recovery.map((item) => ({
            kind: "recovery" as const,
            text: `${issue.operation}: ${item.text}`,
          })),
          ...(issue.diagnostics ?? []).map((text, index) => ({
            code: `${issue.operation}/${issue.code}/diagnostic-${index}`,
            kind: "recovery" as const,
            text: `${issue.operation}: ${text}`,
            expandedOnly: true as const,
          })),
        ])
      : (details.compactAttention?.notices ?? [])),
    ...details.toolCalls.flatMap((call) =>
      call.compact?.version === 2
        ? call.compact.notices.filter((notice) => !isCompactAttention(notice))
        : (call.compact?.notices ?? []),
    ),
    ...(details.recoveredNotices ?? []),
    ...(details.compactAttention?.incomplete
      ? [
          {
            kind: "warning" as const,
            text: INCOMPLETE_ATTENTION,
            description: "Some operation details are unavailable.",
          },
        ]
      : []),
    ...mcpAttention(details.mcpEvidence).map((text): CompactNotice => ({ kind: "warning", text })),
  ];
  if (
    details.compactAttention === undefined &&
    (details.mcpEvidence?.mcp ?? 0) > 0 &&
    details.counts.failed + details.counts.cancelled > 0
  )
    notices.push({
      kind: "recovery",
      text: "A nested call did not deliver a successful result to the program. MCP work may already have completed; do not replay it to recover output.",
      description: "An operation may have finished, but its result did not reach the program.",
    });
  return notices;
};

export const codeModeVisibleNotices = (
  details: CodeModeRenderDetails,
  expanded: boolean,
): CompactNotice[] => [
  ...codeModeEvidenceNotices(details).filter((notice) => expanded || isCompactAttention(notice)),
  ...[codeModeOutputNotice(details)].flatMap((notice) =>
    notice !== undefined && (expanded || isCompactAttention(notice)) ? [notice] : [],
  ),
  ...(details.cancelled
    ? [
        {
          kind: "warning" as const,
          text: "Execution cancelled; prior side effects are not rolled back.",
        },
      ]
    : details.counts.cancelled > 0
      ? [
          {
            kind: "warning" as const,
            text: `${details.counts.cancelled} nested operations cancelled; prior side effects are not rolled back.`,
          },
        ]
      : []),
];
