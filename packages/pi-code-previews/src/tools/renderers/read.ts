import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "../../syntax/language";
import { getPathArg, getReadLineRange } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { agentNotesSection } from "./shared/output-notice";
import { pathPreviewLanguage, renderContentPreview } from "./shared/preview-text";
import { readResultBody } from "./shared/read-result";
import { renderResultPrelude } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { hostObject } from "../../shared/untrusted-value";

export function readPreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme) {
      const input = hostObject(args);
      const path = getPathArg(input);
      const lang = pathPreviewLanguage(path);
      const range = getReadLineRange(input);
      let text = `${renderCodePreviewToolTitle("read", theme)} ${renderDisplayPath(path, cwd, theme)}`;
      if (range) text += theme.fg("warning", range);
      text += metadata(theme, [lang ? normalizePreviewLanguageAlias(lang) : undefined]);
      return new Text(text, 0, 0);
    },

    renderResult: (result, { expanded, isPartial }, theme, renderContext) => {
      const firstText = getTextContent(result.content);
      const prelude = renderResultPrelude({
        isPartial,
        theme,
        loadingLabel: "Reading…",
        isError: renderContext.isError,
        expanded,
        errorText: firstText,
      });
      if (prelude) return prelude;

      const input = hostObject(renderContext.args);
      const body = readResultBody(result, input);

      if (body.kind === "image") {
        return new Text(
          theme.fg(
            "dim",
            escapeControlChars(Fn.pipe(body.text, Str.replace(/^Read image file/i, "image"))),
          ),
          0,
          0,
        );
      }

      if (!expanded && !codePreviewSettings.readContentPreview)
        return renderHiddenPreviewExpandHint(renderContext.state, theme, "content");

      if (body.kind === "oversized")
        return expanded && body.notice ? agentNotesSection(theme, body.notice) : new Container();

      const { content, firstLine } = body;
      return renderContentPreview({
        content,
        limit: expanded ? 0 : codePreviewSettings.readCollapsedLines,
        lang: pathPreviewLanguage(getPathArg(input), content),
        theme,
        invalidate: renderContext.invalidate,
        firstLine,
        emptyLabel: "Empty file",
        skipHighlightLabel: "Syntax highlighting skipped for large file",
      });
    },
  };
}
