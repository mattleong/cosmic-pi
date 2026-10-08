import * as Predicate from "effect/Predicate";

import { Text } from "@earendil-works/pi-tui";
import { renderGrepOutputLines } from "../../tools/grep-render";
import { renderDisplayPath } from "../../paths/display";
import { metadata, previewFooter, trimSingleTrailingNewline } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { shouldSkipHighlight } from "../../syntax/render";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { splitListingNotice, withAgentNotes } from "./shared/output-notice";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderResultPrelude } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";

export function grepPreviewRenderers(cwd: string): PreviewRenderers {
  return {
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

    renderResult: (result, { expanded, isPartial }, theme, renderContext) => {
      const output = trimSingleTrailingNewline(getTextContent(result.content));
      const prelude = renderResultPrelude({
        isPartial,
        theme,
        loadingLabel: "Searching…",
        isError: renderContext.isError,
        expanded,
        errorText: output,
      });
      if (prelude) return prelude;
      if (!expanded && !codePreviewSettings.grepResultPreview)
        return renderHiddenPreviewExpandHint(renderContext.state, theme, "output");
      if (!output || output === "No matches found")
        return new Text(theme.fg("muted", output || "No matches found"), 0, 0);

      const { lines: rawLines, notice } = splitListingNotice(output.split("\n"));
      const limit = expanded ? rawLines.length : codePreviewSettings.grepCollapsedLines;
      const skipHighlight = shouldSkipHighlight(output);
      let text = renderSelectedOutputLines(rawLines, limit, theme, "grep output lines", (chunk) =>
        renderGrepOutputLines(
          chunk.join("\n"),
          theme,
          renderContext.args,
          renderContext.invalidate,
          !skipHighlight,
        ),
      );
      if (skipHighlight)
        text += previewFooter(theme, "Syntax highlighting skipped for large grep output");
      return withAgentNotes(new Text(text, 0, 0), theme, expanded ? notice : undefined);
    },
  };
}
