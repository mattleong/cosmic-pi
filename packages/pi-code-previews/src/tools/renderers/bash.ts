import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

import { Container, Text } from "@earendil-works/pi-tui";
import { trimSingleTrailingNewline } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { hostObject, ownField, type HostObject } from "../../shared/untrusted-value";
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

function shouldHideBashResult(args: HostObject | undefined): boolean {
  const command = ownField(args, "command");
  return shouldHideShellResultByCommand(
    Predicate.isString(command) ? getFirstShellCommandName(command) : undefined,
    codePreviewSettings,
  );
}

export function bashPreviewRenderers(): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      const input = hostObject(args);
      const commandArg = ownField(input, "command");
      const timeoutArg = ownField(input, "timeout");
      const command = Predicate.isString(commandArg) ? commandArg : "";
      const timeout = Predicate.isNumber(timeoutArg)
        ? theme.fg("muted", ` (timeout ${timeoutArg}s)`)
        : "";
      const highlighted = Arr.join(
        renderHighlightedText(command || "…", "bash", theme, renderContext.invalidate),
        "\n",
      );
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
      if (
        !expanded &&
        !renderContext.isError &&
        shouldHideBashResult(hostObject(renderContext.args))
      )
        return renderHiddenPreviewExpandHint(renderContext.state, theme, "output");
      const output = trimSingleTrailingNewline(getTextContent(result.content));
      const lines = output ? Str.split(output, "\n") : [];
      const { lines: rawLines, notice } = splitShellNotice(
        renderContext.isError ? withoutShellStatus(lines) : lines,
      );
      const limit = expanded ? rawLines.length : 8;
      const color = renderContext.isError ? "error" : "muted";
      const text = rawLines.length
        ? renderSelectedOutputLines(rawLines, limit, theme, "output lines", (chunk) =>
            Arr.map(chunk, (line) => theme.fg(color, escapeControlChars(line))),
          )
        : theme.fg("muted", "No output");
      return withAgentNotes(new Text(text, 0, 0), theme, expanded ? notice : undefined);
    },
  };
}
