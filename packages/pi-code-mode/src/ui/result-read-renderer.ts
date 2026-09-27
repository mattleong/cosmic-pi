import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { CompactSummary } from "pi-code-previews";
import { toolRunningLine } from "pi-cosmic-ui/tool";
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
  // A failed read keeps its page quiet: the shell's issue explains it.
  const counter = isError || summary?.outcome === "error" ? "" : (summary?.counters?.[0] ?? "");
  return renderPlainResultView(counter, raw, { isPartial, expanded, contentOnly }, theme);
}

/**
 * The read and status views: a running line, a routine counter, and the raw page when expanded.
 * The shell shows the heading and the issues, so this slot never repeats an outcome.
 */
export function renderPlainResultView(
  counter: string,
  raw: string,
  view: {
    readonly isPartial: boolean;
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
  const heading = isPartial
    ? [invokeHostCallback(() => toolRunningLine(theme), "Running…")]
    : contentOnly || !counter
      ? []
      : [paint("muted", counter)];
  // Painted up front so a hostile theme cannot fail while drawing.
  const output =
    expanded && !isPartial && raw.length > 0
      ? ([
          [2, new Text(paint("muted", "Output"), 0, 0)],
          [4, new Text(paint("toolOutput", raw), 0, 0)],
        ] as const)
      : [];
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const safeWidth = Math.floor(width);
      return [
        ...new Text(heading.join("\n"), 0, 0).render(safeWidth),
        // Same nesting as shared expanded sections: label at two columns, body at four.
        ...output.flatMap(([indent, part]) =>
          part
            .render(Math.max(1, safeWidth - indent))
            .map((line) => `${" ".repeat(indent)}${line}`),
        ),
      ];
    },
    invalidate() {},
  };
}
