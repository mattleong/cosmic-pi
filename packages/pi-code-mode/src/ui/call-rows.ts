/** Shared receipt projection for collapsed and expanded nested calls. */
import type { CompactChild, CompactPhase } from "pi-code-previews";
import { isCompactPiTool } from "../tools/mcp-evidence.ts";
import type { CodeModeCallEntry } from "../tools/format.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

export const codeModeCallRows = (
  details: CodeModeRenderDetails,
  phase: CompactPhase,
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): CompactChild[] =>
  details.toolCalls.map((call): CompactChild => {
    const durationMs =
      call.status === "running"
        ? phase === "running"
          ? liveElapsed?.(call)
          : undefined
        : call.status === "queued"
          ? undefined
          : call.durationMs;
    return {
      label: isCompactPiTool(call.tool)
        ? call.tool.slice(3)
        : call.compact !== undefined && call.tool === "mcp.request"
          ? "mcp"
          : call.compact !== undefined && call.tool === "session.backgroundTask"
            ? "background_task"
            : call.tool,
      ...(call.subject !== undefined && { subject: call.subject }),
      ...(call.compact !== undefined && {
        subject: call.compact.subject,
        ...(call.compact.failureEvidence && { failureEvidence: call.compact.failureEvidence }),
        ...(call.compact.action !== undefined && { action: call.compact.action }),
        ...(call.compact.counters !== undefined && { counters: call.compact.counters }),
        ...(call.compact.metadata !== undefined && { metadata: call.compact.metadata }),
        notices: call.compact.notices,
        ...(call.compact.version === 2 && { issues: call.compact.issues }),
      }),
      ...(durationMs !== undefined && { durationMs }),
      // Delivery failure takes precedence over a successful operation receipt.
      status: call.compact?.deliveryFailed
        ? call.compact.outcome === "uncertain"
          ? "uncertain"
          : "error"
        : call.status === "error" && call.compact?.outcome === "uncertain"
          ? "uncertain"
          : call.status === "completed"
            ? (call.compact?.outcome ??
              (isCompactPiTool(call.tool) && details.compactAttention === undefined
                ? "success"
                : "returned"))
            : call.status === "queued" || call.status === "running"
              ? phase === "settled"
                ? "uncertain"
                : call.status === "queued"
                  ? "pending"
                  : "running"
              : call.status,
    };
  });
