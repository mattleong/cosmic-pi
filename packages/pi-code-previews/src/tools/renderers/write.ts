import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { createWriteToolDefinition, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSimpleDiff } from "../../diff/structured";
import { describeDiffContract, diffSummarySeparator, summarizeDiff } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { countContentLines } from "../../preview/line-counts";
import { hiddenPreviewExpandHintForShell } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { countLabel, formatBytes } from "../../shared/helpers";
import { getObjectValue } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";
import { resolvePreviewLanguage } from "../../syntax/language";
import { normalizePreviewLanguageAlias } from "../../syntax/language";
import { getPathArg } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewToolDefinition } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import {
  getWriteDiffSkipReason,
  readExistingFileForPreview,
  shouldSkipWriteDiffBytes,
  shouldSkipWriteDiffComplexity,
} from "../../write/diff";
import {
  executeWriteWithPreview,
  getCodePreviewBeforeWrite,
  isKnownNewWrite,
  withCodePreviewBeforeWrite,
} from "../../write/preview-execution";
import { cachedDeferredPreview, cachedPreview } from "./shared/cache";
import { diffPreviewCacheKey, writeCallPreviewCacheKey } from "./shared/preview-cache-key";
import { renderContentPreview } from "./shared/content-preview";
import { diffPreviewLineLimit, formatDiffPreview } from "./shared/diff-preview";

export function createWritePreviewTool(cwd: string) {
  const originalWrite = createWriteToolDefinition(cwd);

  return createCodePreviewToolDefinition(originalWrite, {
    compactSummary: (input) => createBuiltinCompactSummary("write", input),
    expandedContent: builtinExpandedContent<typeof originalWrite>("write", cwd),
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = getPathArg(params);
      const content = getObjectValue(params, "content");
      if (!path || !Predicate.isString(content)) {
        const before = path
          ? readExistingFileForPreview(path, cwd, "")
          : Promise.resolve(undefined);
        return before.then((snapshot) =>
          originalWrite
            .execute(toolCallId, params, signal, onUpdate, ctx)
            .then((result) => withCodePreviewBeforeWrite(result, snapshot, toolCallId)),
        );
      }
      return executeWriteWithPreview(toolCallId, path, content, cwd, signal, ctx);
    },

    renderCall(args, theme, renderContext) {
      const path = getPathArg(args);
      const content = Predicate.isString(args.content) ? args.content : "";
      const lang = resolvePreviewLanguage({
        path,
        content,
        piLanguage: getLanguageFromPath(path),
      });
      if (!renderContext.expanded && !codePreviewSettings.writeContentPreview)
        return new Text(
          `${formatWriteCallHeader(
            content,
            path,
            cwd,
            theme,
            lang,
            countContentLines(content),
          )}${formatOptionalHiddenHint(
            hiddenPreviewExpandHintForShell(renderContext.state, theme),
          )}`,
          0,
          0,
        );
      const previewKey = writeCallPreviewCacheKey(content, path, renderContext.expanded, theme);
      return cachedPreview(
        renderContext.state,
        "writeCallPreviewKey",
        "writeCallPreviewComponent",
        previewKey,
        () =>
          renderWriteCallPreview(
            content,
            path,
            cwd,
            renderContext.expanded,
            theme,
            lang,
            renderContext.invalidate,
          ),
      );
    },

    renderResult(result, { expanded }, theme, renderContext) {
      const firstText = getTextContent(result.content);
      if (renderContext.isError)
        return new Text(theme.fg("error", escapeControlChars(firstText || "Write failed")), 0, 0);

      const path = getPathArg(renderContext.args);
      const content = Predicate.isString(renderContext.args?.content)
        ? renderContext.args.content
        : "";
      const stateKey = "codePreviewWriteBeforeSnapshot";
      const before = Object.hasOwn(renderContext.state, stateKey)
        ? renderContext.state[stateKey]
        : getCodePreviewBeforeWrite(renderContext.toolCallId, result.details);
      renderContext.state[stateKey] = before;
      const beforeContent = getObjectValue(before, "content");
      const skipReason = getWriteDiffSkipReason(before, content);
      if (skipReason)
        return new Text(
          theme.fg("success", "✓ Write applied") +
            theme.fg("muted", ` · diff skipped: ${skipReason}`),
          0,
          0,
        );
      if (Predicate.isString(beforeContent) && beforeContent !== content) {
        if (!expanded && !codePreviewSettings.writeContentPreview)
          return new Text(
            `${theme.fg("success", "✓ Write applied")}${formatOptionalHiddenHint(
              hiddenPreviewExpandHintForShell(renderContext.state, theme),
            )}`,
            0,
            0,
          );
        const skippedFor = shouldSkipWriteDiffBytes(beforeContent, content)
          ? "large content"
          : shouldSkipWriteDiffComplexity(beforeContent, content)
            ? "complex rewrite"
            : undefined;
        if (skippedFor) {
          return new Text(
            theme.fg("success", "✓ Write applied") +
              theme.fg("muted", ` · diff skipped for ${skippedFor}`),
            0,
            0,
          );
        }
        const render = () =>
          renderWriteDiffPreview(
            beforeContent,
            content,
            path,
            expanded,
            theme,
            renderContext.invalidate,
          );
        const source = `${beforeContent}\0${content}`;
        const previewKey = diffPreviewCacheKey(
          "write-result",
          source,
          path,
          expanded,
          theme,
          codePreviewSettings.writeCollapsedLines,
        );
        return cachedDeferredPreview(
          renderContext.state,
          "writeResultPreviewKey",
          "writeResultPreviewComponent",
          previewKey,
          source,
          "Rendering write diff…",
          theme,
          render,
          renderContext.invalidate,
        );
      }
      if (Predicate.isString(beforeContent))
        return new Text(theme.fg("muted", "✓ Write applied · no changes"), 0, 0);
      if (!isKnownNewWrite(before, result.details))
        return new Text(
          theme.fg("success", "✓ Write applied") +
            theme.fg("muted", " · previous content unavailable"),
          0,
          0,
        );
      return new Text(
        theme.fg("success", `✓ New file (${countLabel(countContentLines(content), "line")})`),
        0,
        0,
      );
    },
  });
}

function formatOptionalHiddenHint(hint: string): string {
  return hint ? `\n${hint}` : "";
}

function renderWriteCallPreview(
  content: string,
  path: string,
  cwd: string,
  expanded: boolean,
  theme: Theme,
  lang: string | undefined,
  invalidate?: () => void,
): Text {
  const preview = renderContentPreview({
    content,
    limit: expanded ? 0 : codePreviewSettings.writeCollapsedLines,
    lang,
    theme,
    invalidate,
    emptyLabel: "Empty content",
    skipHighlightLabel: "Syntax highlighting skipped for large content",
  });
  return new Text(
    `${formatWriteCallHeader(content, path, cwd, theme, lang, preview.total)}\n${preview.text}`,
    0,
    0,
  );
}

function formatWriteCallHeader(
  content: string,
  path: string,
  cwd: string,
  theme: Theme,
  lang: string | undefined,
  lineCount: number,
): string {
  let text = `${renderCodePreviewToolTitle("write", theme)} ${renderDisplayPath(path, cwd, theme)}`;
  text += metadata(theme, [
    formatBytes(Buffer.byteLength(content, "utf8")),
    countLabel(lineCount, "line"),
    lang ? normalizePreviewLanguageAlias(lang) : undefined,
  ]);
  return text;
}

function renderWriteDiffPreview(
  before: string,
  content: string,
  path: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const diff = createSimpleDiff(before, content);
  const lang = resolvePreviewLanguage({ path, content, piLanguage: getLanguageFromPath(path) });
  const summary = summarizeDiff(diff);
  const limit = diffPreviewLineLimit(
    summary.totalLines,
    expanded,
    codePreviewSettings.writeCollapsedLines,
  );
  const header = `${theme.fg("success", "✓ Write applied")} ${theme.fg("muted", describeDiffContract(summary))}${diffSummarySeparator(theme)}${theme.fg("success", `+${summary.additions}`)} ${theme.fg("error", `-${summary.removals}`)}\n`;
  const preview = formatDiffPreview(diff, lang, theme, limit, {
    totalLines: summary.totalLines,
    hiddenLineNoun: "diff lines",
    skipHighlightLabel: "Syntax highlighting skipped for large diff",
    invalidate,
  });
  return new FullWidthDiffText(header + preview, theme);
}
