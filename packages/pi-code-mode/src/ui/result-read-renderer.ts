import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { renderCompactIssues, type CompactSummary } from "pi-code-previews";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
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
  const counters = summary?.counters ?? [];
  const view = { isPartial, failed, expanded, contentOnly };
  return renderPlainResultView([status, ...counters].join(" · "), raw, summary, view, theme);
}

/** Plain status line and raw page shared by the read and status views. */
export function renderPlainResultView(
  status: string,
  raw: string,
  summary: CompactSummary | undefined,
  view: {
    readonly isPartial: boolean;
    readonly failed: boolean;
    readonly expanded: boolean;
    readonly contentOnly: boolean;
  },
  theme: Theme,
): Component {
  const { isPartial, expanded, contentOnly } = view;
  const paint = (color: "muted" | "error" | "toolOutput", text: string) => {
    const safe = codeModeOutputText(text);
    return invokeHostCallback(() => theme.fg(color, safe), safe);
  };
  // Content-only slots sit under the shell's heading and issues.
  const heading = contentOnly && summary ? [] : [paint(view.failed ? "error" : "muted", status)];
  // Painted up front so a hostile theme cannot fail while drawing.
  const output =
    expanded && !isPartial && raw.length > 0
      ? ([
          [2, new Text(paint("muted", "Output"), 0, 0)],
          [4, new Text(paint("toolOutput", raw), 0, 0)],
        ] as const)
      : [];
  const issues = summary && !contentOnly ? summary.issues : undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const safeWidth = Math.floor(width);
      const body = [
        ...new Text(heading.join("\n"), 0, 0).render(safeWidth),
        // Same nesting as shared expanded sections: label at two columns, body at four.
        ...output.flatMap(([indent, part]) =>
          part
            .render(Math.max(1, safeWidth - indent))
            .map((line) => `${" ".repeat(indent)}${line}`),
        ),
      ];
      if (!issues?.length) return body;
      try {
        return [...renderCompactIssues(issues, theme, safeWidth, expanded, ""), ...body];
      } catch {
        // A hostile host theme cannot hide retained recovery evidence.
        const evidence = issues.flatMap((issue) =>
          issue.severity === "info" && !expanded
            ? []
            : [issue.message, ...(expanded && issue.detail ? [issue.detail] : [])],
        );
        return [
          ...new Text(evidence.map(codeModeOutputText).join("\n"), 0, 0).render(safeWidth),
          ...body,
        ];
      }
    },
    invalidate() {},
  };
}
