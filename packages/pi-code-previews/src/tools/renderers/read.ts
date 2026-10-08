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

export function readPreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme) {
      const path = getPathArg(args);
      const lang = pathPreviewLanguage(path);
      // The same first line Pi reads and the gutter numbers, including for offset 0.
      const range = getReadLineRange(args);
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

      const body = readResultBody(result, renderContext.args);

      // Pi already renders image content parts natively. Avoid emitting terminal image
      // escape sequences here; show only a compact note beside Pi's image renderer.
      if (body.kind === "image") {
        return new Text(
          theme.fg("dim", escapeControlChars(body.text.replace(/^Read image file/i, "image"))),
          0,
          0,
        );
      }

      if (!expanded && !codePreviewSettings.readContentPreview)
        return renderHiddenPreviewExpandHint(renderContext.state, theme, "content");

      // The issue line already reports an oversized first line; expansion adds the agent's notes.
      if (body.kind === "oversized")
        return expanded && body.notice ? agentNotesSection(theme, body.notice) : new Container();

      const { content, firstLine } = body;
      return renderContentPreview({
        content,
        limit: expanded ? 0 : codePreviewSettings.readCollapsedLines,
        lang: pathPreviewLanguage(getPathArg(renderContext.args), content),
        theme,
        invalidate: renderContext.invalidate,
        firstLine,
        emptyLabel: "Empty file",
        skipHighlightLabel: "Syntax highlighting skipped for large file",
      });
    },
  };
}
