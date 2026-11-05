import * as Arr from "effect/Array";
import * as Str from "effect/String";

import { Text } from "@earendil-works/pi-tui";
import { captureCodePreviewSessionCapability } from "../../application/capability";
import { parseGrepOutputLine, renderGrepOutputLines } from "../../tools/grep-render";
import { renderDisplayPath } from "../../paths/display";
import { metadata, previewFooter, trimSingleTrailingNewline } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { shouldSkipHighlight } from "../../syntax/render";
import { numericArg, stringArg } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { splitListingNotice, withAgentNotes, withCollapsedLimit } from "./shared/output-notice";
import { cachedDeferredPreview } from "./shared/cache";
import { previewCacheKey } from "./shared/preview-cache-key";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderResultPrelude } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";
import { previewHeadingText } from "../../preview/heading-wrap";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { hostObject } from "../../shared/untrusted-value";

export function grepPreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme) {
      const input = hostObject(args);
      const pattern = stringArg(input, "pattern");
      const path = stringArg(input, "path") || ".";
      const glob = stringArg(input, "glob") || undefined;
      const limit = numericArg(input, "limit");
      let text = `${renderCodePreviewToolTitle("grep", theme)} ${theme.fg("accent", `/${escapeControlChars(pattern)}/`)} ${theme.fg("muted", "in")} ${renderDisplayPath(path, cwd, theme)}`;
      text += metadata(theme, [
        glob ? escapeControlChars(glob) : undefined,
        limit ? `limit ${limit}` : undefined,
      ]);
      return previewHeadingText(() => text);
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
        return renderHiddenPreviewExpandHint(renderContext, theme, "output");
      if (!output || output === "No matches found")
        return new Text(theme.fg("muted", output || "No matches found"), 0, 0);

      const { lines: rawLines, notice } = splitListingNotice(Str.split(output, "\n"));
      const collapsedLines = codePreviewSettings.grepCollapsedLines;
      const limit = expanded ? rawLines.length : collapsedLines;
      const skipHighlight = shouldSkipHighlight(output);
      // Hidden rows are matches, unless context lines are shown among them.
      const hidden = Arr.some(rawLines, (line) => parseGrepOutputLine(line)?.kind === "context")
        ? { singular: "line" }
        : { singular: "match", plural: "matches" };
      const { args, invalidate } = renderContext;
      const render = (active: boolean) => {
        let text = renderSelectedOutputLines(rawLines, limit, theme, hidden, (chunk) =>
          renderGrepOutputLines(
            Arr.join(chunk, "\n"),
            theme,
            hostObject(args),
            invalidate,
            active && !skipHighlight,
          ),
        );
        if (!expanded)
          text = withCollapsedLimit(
            text,
            theme,
            "grep",
            hostObject(result.details),
            hostObject(args),
            notice,
          );
        if (skipHighlight)
          text += previewFooter(theme, "Syntax highlighting skipped for large grep output");
        return new Text(text, 0, 0);
      };
      // Collapsed previews highlight only their visible lines, so only full output is deferred.
      const preview = cachedDeferredPreview(
        renderContext.state,
        "grepResultPreview",
        [...previewCacheKey([output], "", expanded, theme, collapsedLines), args],
        expanded ? output.length : 0,
        "Rendering matches…",
        theme,
        render,
        invalidate,
        captureCodePreviewSessionCapability(),
      );
      return withAgentNotes(preview, theme, expanded ? notice : undefined);
    },
  };
}
