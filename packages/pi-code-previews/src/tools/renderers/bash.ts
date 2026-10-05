import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { CodePreviewRendererSession } from "../../application/renderer-contract";
import { Container, Text } from "@earendil-works/pi-tui";
import { showingFooter, trimSingleTrailingNewline } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { getObjectValue } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";
import { getFirstShellCommandName } from "../../tools/shell-command";
import { renderHighlightedText } from "../../syntax/render";
import { getTextContent } from "../data/results";
import { withoutShellStatus } from "../builtin-failure-shell";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewRenderers } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { shouldHideShellResultByCommand } from "../shell-result-policy";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderResultPrelude } from "./shared/result-prelude";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { previewIssuesSlot } from "../../preview/preview-issues";

function shouldHideBashResult<ArgsInput>(args: ArgsInput): boolean {
  const command = getObjectValue(args, "command");
  return shouldHideShellResultByCommand(
    Predicate.isString(command) ? getFirstShellCommandName(command) : undefined,
    codePreviewSettings,
  );
}

export function createBashPreviewTool(
  cwd: string,
  session?: Pick<CodePreviewRendererSession, "scheduleAnimation" | "selfShell">,
) {
  return createCodePreviewRenderers(
    { name: "bash" },
    {
      ...session,
      selfShell: true,
      compactSummary: (input) => createBuiltinCompactSummary("bash", input),
      expandedContent: builtinExpandedContent("bash", cwd),
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
          return renderHiddenPreviewExpandHint(renderContext.state, theme);
        const output = trimSingleTrailingNewline(getTextContent(result.content));
        const lines = output ? output.split("\n") : [];
        // The shell's issue line states a failed command's closing status; show only its output.
        const rawLines = renderContext.isError ? withoutShellStatus(lines) : lines;
        const limit = expanded ? rawLines.length : 8;
        const preview = renderSelectedOutputLines(rawLines, limit, theme, (chunk) =>
          chunk.map((line) =>
            theme.fg(renderContext.isError ? "error" : "muted", escapeControlChars(line)),
          ),
        );
        let text = preview.lines.length ? preview.lines.join("\n") : theme.fg("muted", "No output");
        if (preview.hidden > 0)
          text += showingFooter(theme, preview.shown, rawLines.length, "output lines");
        return new Text(text, 0, 0);
      },
    },
  );
}
