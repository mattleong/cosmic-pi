import * as Predicate from "effect/Predicate";

import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderGrepOutputLines } from "../../tools/grep-render";
import { renderDisplayPath } from "../../paths/display";
import {
  metadata,
  previewFooter,
  showingFooter,
  trimSingleTrailingNewline,
} from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { shouldSkipHighlight } from "../../syntax/render";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewToolDefinition } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderHiddenPreviewPrelude, renderResultPrelude } from "./shared/result-prelude";

export function createGrepPreviewTool(cwd: string) {
  const originalGrep = createGrepToolDefinition(cwd);

  return createCodePreviewToolDefinition(originalGrep, {
    compactSummary: (input) => createBuiltinCompactSummary("grep", input),
    renderCall(args, theme) {
      const pattern = Predicate.isString(args.pattern) ? args.pattern : "";
      const path = Predicate.isString(args.path) && args.path ? args.path : ".";
      const glob = Predicate.isString(args.glob) && args.glob ? args.glob : undefined;
      const limit = Predicate.isNumber(args.limit) ? args.limit : undefined;
      let text = `${renderCodePreviewToolTitle("grep", theme)} ${theme.fg("accent", `/${escapeControlChars(pattern)}/`)} ${theme.fg("muted", "in")} ${renderDisplayPath(path, cwd, theme)}`;
      text += metadata(theme, [
        glob ? escapeControlChars(glob) : undefined,
        limit ? `limit ${limit}` : undefined,
      ]);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const output = trimSingleTrailingNewline(getTextContent(result.content));
      const prelude = renderResultPrelude({
        isPartial,
        theme,
        loadingLabel: "Searching…",
        isError: renderContext.isError,
        errorText: output.split("\n")[0] || "Grep failed",
      });
      if (prelude) return prelude;
      const hiddenPrelude = renderHiddenPreviewPrelude({
        expanded,
        state: renderContext.state,
        theme,
        hidePreview: !codePreviewSettings.grepResultPreview,
      });
      if (hiddenPrelude) return hiddenPrelude;
      if (!output || output === "No matches found")
        return new Text(theme.fg("muted", output || "No matches found"), 0, 0);

      const pattern = Predicate.isString(renderContext.args?.pattern)
        ? renderContext.args.pattern
        : "";
      const rawLines = output.split("\n");
      const limit = expanded ? rawLines.length : codePreviewSettings.grepCollapsedLines;
      const skipHighlight = shouldSkipHighlight(output);
      const preview = renderSelectedOutputLines(rawLines, limit, theme, (chunk) =>
        renderGrepOutputLines(
          chunk.join("\n"),
          theme,
          {
            pattern,
            literal: renderContext.args?.literal === true,
            ignoreCase: renderContext.args?.ignoreCase === true,
          },
          renderContext.invalidate,
          { syntaxHighlight: !skipHighlight },
        ),
      );
      let text = preview.lines.join("\n");
      if (preview.hidden > 0)
        text += showingFooter(theme, preview.shown, rawLines.length, "grep output lines");
      if (skipHighlight)
        text += previewFooter(theme, "Syntax highlighting skipped for large grep output");
      return new Text(text, 0, 0);
    },
  });
}
