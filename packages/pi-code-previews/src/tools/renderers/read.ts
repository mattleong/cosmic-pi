import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { CodePreviewRendererAppearance } from "../../application/renderer-contract";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { resolvePreviewLanguage } from "../../syntax/language";
import { normalizePreviewLanguageAlias } from "../../syntax/language";
import { getPathArg, getReadStartLine } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewRenderers } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { renderContentPreview } from "./shared/content-preview";
import { agentNotesSection } from "./shared/output-notice";
import { readResultBody } from "./shared/read-result";
import { renderResultPrelude } from "./shared/result-prelude";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";

export function createReadPreviewTool(cwd: string, session?: CodePreviewRendererAppearance) {
  return createCodePreviewRenderers(
    { name: "read" },
    {
      ...session,
      compactSummary: (input) => createBuiltinCompactSummary("read", input),
      expandedContent: builtinExpandedContent("read", cwd),
      renderCall(args, theme) {
        const path = getPathArg(args);
        const lang = resolvePreviewLanguage({ path, piLanguage: getLanguageFromPath(path) });
        let text = `${renderCodePreviewToolTitle("read", theme)} ${renderDisplayPath(path, cwd, theme)}`;
        if (Predicate.isNumber(args.offset) || Predicate.isNumber(args.limit)) {
          // The same first line Pi reads and the gutter numbers, including for offset 0.
          const start = getReadStartLine(args);
          const end = Predicate.isNumber(args.limit) ? start + args.limit - 1 : undefined;
          text += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
        }
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

        const path = getPathArg(renderContext.args);
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
        const lang = resolvePreviewLanguage({
          path,
          content,
          piLanguage: getLanguageFromPath(path),
        });
        const preview = renderContentPreview({
          content,
          limit: expanded ? 0 : codePreviewSettings.readCollapsedLines,
          lang,
          theme,
          invalidate: renderContext.invalidate,
          firstLine,
          emptyLabel: "Empty file",
          skipHighlightLabel: "Syntax highlighting skipped for large file",
        });
        return new Text(preview.text, 0, 0);
      },
    },
  );
}
