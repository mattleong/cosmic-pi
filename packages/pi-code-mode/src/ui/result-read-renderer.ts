import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  renderCompactIssues,
  renderExpandedAttention,
  summaryCompactIssues,
  type CompactSummary,
} from "pi-code-previews";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { decodeOption } from "../tools/format.ts";
import { codeModeOutputText } from "./result-output.ts";

const ReadRequest = Schema.Struct({
  action: Schema.Literal("result.read"),
  id: Schema.optional(Schema.Unknown),
});

/** Request identity selects the read view, even for old results without metadata. */
export function codeModeReadRequest<Args>(args: Args): { readonly id: string } | undefined {
  const request = decodeOption(ReadRequest, args);
  return request ? { id: Predicate.isString(request.id) ? request.id : "" } : undefined;
}

/** Only producer metadata in the summary can establish read or original-execution
 * outcomes. Raw page text is displayed, never interpreted as execution evidence. */
export function renderCodeModeResultRead(
  raw: string,
  summary: CompactSummary | undefined,
  isPartial: boolean,
  isError: boolean,
  expanded: boolean,
  theme: Theme,
  contentOnly = false,
): Component {
  const failed = isError || summary?.outcome === "error";
  const status = isPartial
    ? "Reading retained result"
    : failed
      ? "Retained read failed"
      : summary?.outcome === undefined
        ? "Read outcome unavailable"
        : "Page read succeeded";
  const lines: Array<{ text: string; color: "muted" | "error" | "warning" | "toolOutput" }> = [
    { text: [status, ...(summary?.counters ?? [])].join(" · "), color: failed ? "error" : "muted" },
  ];
  if (contentOnly && summary) lines.length = 0;
  const issues = summary && !contentOnly ? summaryCompactIssues(summary, expanded) : undefined;
  if (expanded && !isPartial && raw.length) {
    lines.push(
      { text: "Raw output", color: "muted" },
      { text: codeModeOutputText(raw), color: "toolOutput" },
    );
  }
  // A hostile host theme cannot hide retained recovery evidence.
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const text = lines
        .map(({ text, color }) => {
          const safe = codeModeOutputText(text);
          try {
            return theme.fg(color, safe);
          } catch {
            return safe;
          }
        })
        .join("\n");
      const body = new Text(text, 0, 0).render(Math.floor(width));
      if (!issues) return body;
      try {
        const attention = expanded
          ? renderExpandedAttention(issues, [], theme, width)
          : renderCompactIssues(issues, theme, width);
        return [...attention, ...body];
      } catch {
        const evidence = issues.entries.flatMap((issue) => [
          issue.cause,
          ...issue.recovery.map((item) => item.text),
          ...(expanded ? (issue.diagnostics ?? []) : []),
        ]);
        return [
          ...new Text(evidence.map(codeModeOutputText).join("\n"), 0, 0).render(Math.floor(width)),
          ...body,
        ];
      }
    },
    invalidate() {},
  };
}
