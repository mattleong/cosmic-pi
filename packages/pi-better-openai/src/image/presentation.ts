import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  planCompactPresentation,
  renderCompactRow,
  renderCompactIssues,
  renderExpandedAttention,
  summaryCompactIssues,
  type CompactSummary,
} from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeImageTextDetails = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt: Schema.String,
    revisedPrompt: Schema.optional(Schema.String),
    savedPath: Schema.optional(Schema.String),
  }),
);

/** Native tool image attachments stay with Pi; this hook returns text only. */
export function renderImageContent(result: {
  details?: unknown;
  content: readonly { type: string; text?: string }[];
}): Text {
  const raw = result.content
    .filter((part) => part.type === "text")
    .map((part) => stripTerminalControls(part.text ?? ""))
    .join("\n");
  const lines: string[] = [];
  const details = Option.getOrUndefined(decodeImageTextDetails(result.details));
  if (details) {
    for (const [key, label] of [
      ["prompt", "Prompt"],
      ["revisedPrompt", "Revised prompt"],
      ["savedPath", "Saved"],
    ] as const) {
      const value = details[key];
      if (value !== undefined) lines.push(`${label}: ${stripTerminalControls(value)}`);
    }
  }
  if (raw) lines.push("Raw result", raw);
  return new Text(lines.join("\n"), 0, 0);
}

/** Custom messages own their Image components separately from this text presentation. */
export function imageMessagePresentation(
  summary: CompactSummary | undefined,
  text: string,
  expanded: boolean,
  theme: Theme,
): Component {
  const plan = planCompactPresentation({ summary, phase: "settled", isError: false, expanded });
  return {
    invalidate() {},
    render(width) {
      const lines = [
        renderCompactRow(
          { name: "openai_image", phase: "settled", summary: plan.collapsedSummary },
          theme,
          width,
        ),
      ];
      if (!expanded) lines.push(...renderCompactIssues(plan.issues, theme, width));
      if (expanded)
        lines.push(
          ...renderExpandedAttention(
            summary ? summaryCompactIssues(summary, true) : { coverage: "unknown", entries: [] },
            summary?.expandedResultOwnsIssues,
            theme,
            width,
          ),
          ...new Text(stripTerminalControls(text), 0, 0).render(width),
        );
      return lines;
    },
  };
}
