import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererSession } from "../../application/renderer-contract";
import { createWriteToolDefinition, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSimpleDiff } from "../../diff/structured";
import { describeDiffContract, diffSummarySeparator, summarizeDiff } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { countContentLines } from "../../preview/line-counts";
import { hiddenPreviewExpandHintForShell } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { getObjectValue } from "../../shared/helpers";
import { resolvePreviewLanguage } from "../../syntax/language";
import { normalizePreviewLanguageAlias } from "../../syntax/language";
import { getPathArg } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewRenderers } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import {
  getWriteDiffGuard,
  getWriteDiffSkipReason,
  readExistingFileForPreview,
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
import { renderPreviewError } from "./shared/result-prelude";
import { countLabel, formatBytes } from "pi-cosmic-core";
import { previewIssuesSlot } from "../../preview/preview-issues";

export function createWritePreviewTool(cwd: string) {
  const originalWrite = createWriteToolDefinition(cwd);

  // Native rendering is selected independently; the hook owns execution only.
  const { renderCall: _renderCall, renderResult: _renderResult, ...definition } = originalWrite;
  return {
    ...definition,
    execute(...args: Parameters<typeof originalWrite.execute>) {
      const [toolCallId, params, signal, onUpdate, ctx] = args;
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
  };
}

/** Presentation is independent of the before-write execution hook. */
export function createWritePreviewRenderers(
  cwd: string,
  session?: Pick<CodePreviewRendererSession, "scheduleAnimation" | "selfShell">,
) {
  return createCodePreviewRenderers(
    { name: "write" },
    {
      ...session,
      selfShell: true,
      compactSummary: (input) => createBuiltinCompactSummary("write", input),
      expandedContent: builtinExpandedContent("write", cwd),
      renderCall(args, theme, renderContext) {
        const path = getPathArg(args);
        const content = Predicate.isString(args.content) ? args.content : "";
        const lang = resolvePreviewLanguage({
          path,
          content,
          piLanguage: getLanguageFromPath(path),
        });
        const issues = previewIssuesSlot(renderContext);
        if (!renderContext.expanded && !codePreviewSettings.writeContentPreview) {
          const hidden = new Container();
          hidden.addChild(
            new Text(
              formatWriteCallHeader(content, path, cwd, theme, lang, countContentLines(content)),
              0,
              0,
            ),
          );
          hidden.addChild(issues);
          const hint = hiddenPreviewExpandHintForShell(renderContext.state, theme);
          if (hint) hidden.addChild(new Text(hint, 0, 0));
          return hidden;
        }
        const previewKey = writeCallPreviewCacheKey(content, path, renderContext.expanded, theme);
        const preview = cachedPreview(
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
              issues,
              renderContext.invalidate,
            ),
        );
        return preview;
      },

      renderResult: (result, { expanded }, theme, renderContext) => {
        const firstText = getTextContent(result.content);
        if (renderContext.isError) return renderPreviewError(theme, expanded, firstText);

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
        const applied = (note: string) =>
          new Text(theme.fg("success", "✓ Write applied") + note, 0, 0);
        const skipReason = getWriteDiffSkipReason(before, content);
        if (skipReason) return applied(theme.fg("muted", ` · diff skipped: ${skipReason}`));
        if (Predicate.isString(beforeContent) && beforeContent !== content) {
          if (!expanded && !codePreviewSettings.writeContentPreview)
            return applied(
              formatOptionalHiddenHint(hiddenPreviewExpandHintForShell(renderContext.state, theme)),
            );
          const guard = getWriteDiffGuard(beforeContent, content);
          if (guard) {
            const skippedFor = guard === "size" ? "large content" : "complex rewrite";
            return applied(theme.fg("muted", ` · diff skipped for ${skippedFor}`));
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
        // Missing history is an issue above the body.
        if (!isKnownNewWrite(before, result.details)) return applied("");
        return new Text(
          theme.fg("success", `✓ New file (${countLabel(countContentLines(content), "line")})`),
          0,
          0,
        );
      },
    },
  );
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
  issues: Component,
  invalidate?: () => void,
): Container {
  const preview = renderContentPreview({
    content,
    limit: expanded ? 0 : codePreviewSettings.writeCollapsedLines,
    lang,
    theme,
    invalidate,
    emptyLabel: "Empty content",
    skipHighlightLabel: "Syntax highlighting skipped for large content",
  });
  // Issues sit directly under the heading, above the content they may describe.
  const container = new Container();
  container.addChild(
    new Text(formatWriteCallHeader(content, path, cwd, theme, lang, preview.total), 0, 0),
  );
  container.addChild(issues);
  container.addChild(new Text(preview.text, 0, 0));
  return container;
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
