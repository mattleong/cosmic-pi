import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { countLabel } from "pi-cosmic-core/display";
import { renderExpansionAffordance, toolRunningLine } from "pi-cosmic-ui/tool";
import { trimSingleTrailingNewline } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { hostObject, ownField, type HostObject } from "../../shared/untrusted-value";
import { escapeControlChars } from "../../shared/terminal-text";
import { getFirstShellCommandName } from "../../tools/shell-command";
import { renderHighlightedText } from "../../syntax/render";
import { stringArg } from "../data/args";
import { getTextContent } from "../data/results";
import { withoutShellStatus } from "../builtin-failure-shell";
import { renderCodePreviewToolTitle } from "../presentation";
import { shouldHideShellResultByCommand } from "../policy";
import { splitShellNotice, withAgentNotes } from "./shared/output-notice";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderResultPrelude } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { previewIssuesSlot } from "../../preview/preview-issues";
import { wrapPreviewHeading } from "../../preview/heading-wrap";

function shouldHideBashResult(args: HostObject | undefined): boolean {
  return shouldHideShellResultByCommand(
    getFirstShellCommandName(stringArg(args, "command")),
    codePreviewSettings,
  );
}

// Streaming output a collapsed running row shows: its latest lines, as a terminal would.
const STREAMING_TAIL_LINES = 5;

/**
 * A running call's latest output beneath its running line. The earlier lines it hides are named
 * where they would be, between the running line and the tail.
 */
function streamingTail(lines: readonly string[], theme: Theme): Component {
  const tail = lines.slice(-STREAMING_TAIL_LINES);
  const earlier = lines.length - tail.length;
  const rows = [
    toolRunningLine(theme),
    ...(earlier > 0
      ? [renderExpansionAffordance(countLabel(earlier, "earlier line"), false, theme)]
      : []),
    ...Arr.map(tail, (line) => theme.fg("muted", escapeControlChars(line))),
  ];
  return new Text(Arr.join(rows, "\n"), 0, 0);
}

/**
 * The heading and its command, wrapped as preview headings wrap. A multi-line command's later
 * lines hang beneath the heading as its wrapped rows do, so none reads as output.
 */
function commandHeading(lines: readonly string[]): Component {
  let cached: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render(width) {
      if (cached?.width === width) return cached.rows;
      const hang = width > COMMAND_HANG.length * 4 ? COMMAND_HANG : "";
      const rows = Arr.flatMap(lines, (line, index) =>
        index === 0
          ? wrapPreviewHeading(line, width)
          : Arr.map(wrapPreviewHeading(line, width - hang.length), (row) => `${hang}${row}`),
      );
      cached = { width, rows };
      return rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

const COMMAND_HANG = "  ";

export function bashPreviewRenderers(): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      const input = hostObject(args);
      const command = stringArg(input, "command");
      const timeoutArg = ownField(input, "timeout");
      const timeout = Predicate.isNumber(timeoutArg)
        ? theme.fg("muted", ` (timeout ${timeoutArg}s)`)
        : "";
      const [first = "", ...rest] = renderHighlightedText(
        command || "…",
        "bash",
        theme,
        renderContext.invalidate,
      );
      const rows = [`${renderCodePreviewToolTitle("bash", theme)} ${first}`, ...rest];
      const lines = Arr.map(rows, (line, index) =>
        index === rows.length - 1 ? `${line}${timeout}` : line,
      );
      const heading = new Container();
      heading.addChild(commandHeading(lines));
      heading.addChild(previewIssuesSlot(renderContext));
      return heading;
    },

    renderResult: (result, { expanded, isPartial }, theme, renderContext) => {
      const output = trimSingleTrailingNewline(getTextContent(result.content));
      const lines = output ? Str.split(output, "\n") : [];
      const hidden = !renderContext.isError && shouldHideBashResult(hostObject(renderContext.args));
      if (isPartial && !expanded && !hidden && Arr.some(lines, (line) => Str.trim(line) !== ""))
        return streamingTail(lines, theme);
      const prelude = renderResultPrelude({ isPartial, theme });
      if (prelude) return prelude;
      if (!expanded && hidden)
        return renderHiddenPreviewExpandHint(renderContext.state, theme, "output");
      const { lines: rawLines, notice } = splitShellNotice(
        renderContext.isError ? withoutShellStatus(lines) : lines,
      );
      const limit = expanded ? rawLines.length : 8;
      const color = renderContext.isError ? "error" : "muted";
      const text = rawLines.length
        ? renderSelectedOutputLines(rawLines, limit, theme, { singular: "output line" }, (chunk) =>
            Arr.map(chunk, (line) => theme.fg(color, escapeControlChars(line))),
          )
        : theme.fg("muted", "No output");
      return withAgentNotes(new Text(text, 0, 0), theme, expanded ? notice : undefined);
    },
  };
}
