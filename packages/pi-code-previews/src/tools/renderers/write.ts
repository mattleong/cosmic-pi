import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererAppearance } from "../../application/renderer-contract";
import { createWriteToolDefinition, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSimpleDiff } from "../../diff/structured";
import { describeDiffContract, diffSummarySeparator, summarizeDiff } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { countContentLines } from "../../preview/line-counts";
import { hiddenPreviewExpandHintForShell } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { getObjectValue } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";
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
  hasWriteDiffSizeEvidence,
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
import { diffPreviewLineLimit, diffSkippedNote, formatDiffPreview } from "./shared/diff-preview";
import { setResultDiffShown, unlessResultDiffShown } from "./shared/result-diff";
import { renderPreviewError } from "./shared/result-prelude";
import type { RendererState } from "./shared/types";
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
export function createWritePreviewRenderers(cwd: string, session?: CodePreviewRendererAppearance) {
  return createCodePreviewRenderers(
    { name: "write" },
    {
      ...session,
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
        const heading = new Text("", 0, 0);
        renderContext.state.writeHeaderText = heading;
        renderContext.state.writeHeader = { content, path, lang };
        updateWriteHeader(renderContext.state, cwd, theme);
        // Issues sit directly under the heading, above the content they may describe.
        const container = new Container();
        container.addChild(heading);
        container.addChild(previewIssuesSlot(renderContext));
        if (!renderContext.expanded && !codePreviewSettings.writeContentPreview) {
          const hint = hiddenPreviewExpandHintForShell(renderContext.state, theme);
          if (hint) container.addChild(new Text(hint, 0, 0));
          return container;
        }
        const previewKey = writeCallPreviewCacheKey(content, path, renderContext.expanded, theme);
        const preview = () =>
          cachedPreview(
            renderContext.state,
            "writeCallPreviewKey",
            "writeCallPreviewComponent",
            previewKey,
            () =>
              renderWriteContentPreview(
                content,
                renderContext.expanded,
                theme,
                lang,
                renderContext.invalidate,
              ),
          );
        // The proposed content stays until the applied diff replaces it.
        container.addChild(unlessResultDiffShown(renderContext.state, preview));
        return container;
      },

      renderResult: (result, { expanded }, theme, renderContext) => {
        const state = renderContext.state;
        setResultDiffShown(state, false);
        const firstText = getTextContent(result.content);
        if (renderContext.isError) {
          setWriteNewFile(state, false, cwd, theme);
          return renderPreviewError(theme, expanded, firstText);
        }

        const path = getPathArg(renderContext.args);
        const content = Predicate.isString(renderContext.args?.content)
          ? renderContext.args.content
          : "";
        const stateKey = "codePreviewWriteBeforeSnapshot";
        const before = Object.hasOwn(state, stateKey)
          ? state[stateKey]
          : getCodePreviewBeforeWrite(renderContext.toolCallId, result.details);
        state[stateKey] = before;
        // Only an observed absent file is new; the heading says so once the write is known.
        setWriteNewFile(state, isKnownNewWrite(before, result.details), cwd, theme);
        const skipReason = getWriteDiffSkipReason(before, content);
        if (skipReason !== undefined) {
          // Other skipped snapshots are explained by the "Diff unavailable" issue.
          return hasWriteDiffSizeEvidence(before)
            ? new Text(theme.fg("muted", `diff skipped: ${escapeControlChars(skipReason)}`), 0, 0)
            : new Container();
        }
        const beforeContent = getObjectValue(before, "content");
        if (!Predicate.isString(beforeContent)) return new Container();
        if (beforeContent === content) return new Text(theme.fg("muted", "no changes"), 0, 0);
        // A hidden collapsed preview leaves expansion to the call's hint.
        if (!expanded && !codePreviewSettings.writeContentPreview) return new Container();
        const guard = getWriteDiffGuard(beforeContent, content);
        if (guard) return new Text(diffSkippedNote(theme, guard), 0, 0);
        // Expansion keeps the exact written content above the diff.
        setResultDiffShown(state, !expanded);
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
          state,
          "writeResultPreviewKey",
          "writeResultPreviewComponent",
          previewKey,
          source,
          "Rendering write diff…",
          theme,
          render,
          renderContext.invalidate,
        );
      },
    },
  );
}

function renderWriteContentPreview(
  content: string,
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
  return new Text(preview.text, 0, 0);
}

function setWriteNewFile(state: RendererState, newFile: boolean, cwd: string, theme: Theme): void {
  state.writeNewFile = newFile;
  updateWriteHeader(state, cwd, theme);
}

/** The result renders after the call, so it rewrites the call's heading in place. */
function updateWriteHeader(state: RendererState, cwd: string, theme: Theme): void {
  const heading = state.writeHeaderText;
  const header = state.writeHeader;
  if (!(heading instanceof Text) || !header) return;
  const { content, path, lang } = header;
  let text = `${renderCodePreviewToolTitle("write", theme)} ${renderDisplayPath(path, cwd, theme)}`;
  text += metadata(theme, [
    state.writeNewFile === true ? "new file" : undefined,
    formatBytes(Buffer.byteLength(content, "utf8")),
    countLabel(countContentLines(content), "line"),
    lang ? normalizePreviewLanguageAlias(lang) : undefined,
  ]);
  heading.setText(text);
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
  const header = `${theme.fg("muted", describeDiffContract(summary))}${diffSummarySeparator(theme)}${theme.fg("success", `+${summary.additions}`)} ${theme.fg("error", `-${summary.removals}`)}\n`;
  const preview = formatDiffPreview(diff, lang, theme, limit, {
    totalLines: summary.totalLines,
    hiddenLineNoun: "diff lines",
    skipHighlightLabel: "Syntax highlighting skipped for large diff",
    invalidate,
  });
  return new FullWidthDiffText(header + preview, theme);
}
