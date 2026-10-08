import * as Predicate from "effect/Predicate";

import { Container, Text } from "@earendil-works/pi-tui";
import { trimSingleTrailingNewline } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { getObjectValue } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";
import { getFirstShellCommandName } from "../../tools/shell-command";
import { renderHighlightedText } from "../../syntax/render";
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

function shouldHideBashResult<ArgsInput>(args: ArgsInput): boolean {
  const command = getObjectValue(args, "command");
  return shouldHideShellResultByCommand(
    Predicate.isString(command) ? getFirstShellCommandName(command) : undefined,
    codePreviewSettings,
  );
}

export function bashPreviewRenderers(): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      const command = Predicate.isString(args.command) ? args.command : "";
      const timeout = Predicate.isNumber(args.timeout)
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      const highlighted = renderHighlightedText(
        command || "…",
        "bash",
        theme,
        renderContext.invalidate,
      ).join("\n");
      // Risky commands and secrets are flagged under the heading, even before execution.
      const heading = new Container();
      heading.addChild(
        new Text(`${renderCodePreviewToolTitle("bash", theme)} ${highlighted}${timeout}`, 0, 0),
      );
      heading.addChild(previewIssuesSlot(renderContext));
      return heading;
    },

    renderResult: (result, { expanded, isPartial }, theme, renderContext) => {
      const prelude = renderResultPrelude({ isPartial, theme });
      if (prelude) return prelude;
      if (!expanded && !renderContext.isError && shouldHideBashResult(renderContext.args))
        return renderHiddenPreviewExpandHint(renderContext.state, theme, "output");
      const output = trimSingleTrailingNewline(getTextContent(result.content));
      const lines = output ? output.split("\n") : [];
      // The shell's issue line states a failed command's closing status; show only its output.
      const { lines: rawLines, notice } = splitShellNotice(
        renderContext.isError ? withoutShellStatus(lines) : lines,
      );
      const limit = expanded ? rawLines.length : 8;
      const color = renderContext.isError ? "error" : "muted";
      const text = rawLines.length
        ? renderSelectedOutputLines(rawLines, limit, theme, "output lines", (chunk) =>
            chunk.map((line) => theme.fg(color, escapeControlChars(line))),
          )
        : theme.fg("muted", "No output");
      return withAgentNotes(new Text(text, 0, 0), theme, expanded ? notice : undefined);
    },
  };
}
