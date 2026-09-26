import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { renderDisplayPath } from "../../paths/display";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewToolDefinition } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { renderPathListResult } from "./shared/path-list-result";
import { withPreviewIssues } from "./shared/preview-issues";

export function createFindPreviewTool(cwd: string) {
  const originalFind = createFindToolDefinition(cwd);

  return createCodePreviewToolDefinition(originalFind, {
    compactSummary: (input) => createBuiltinCompactSummary("find", input),
    expandedContent: builtinExpandedContent<typeof originalFind>("find", cwd),
    renderCall(args, theme) {
      const pattern = Predicate.isString(args.pattern) ? args.pattern : "";
      const path = Predicate.isString(args.path) && args.path ? args.path : ".";
      return new Text(
        `${renderCodePreviewToolTitle("find", theme)} ${theme.fg("accent", escapeControlChars(pattern || "*"))} ${theme.fg("muted", "in")} ${renderDisplayPath(path, cwd, theme)}`,
        0,
        0,
      );
    },
    renderResult: withPreviewIssues("find", (result, options, theme, renderContext) =>
      renderPathListResult(result, options, theme, renderContext, {
        cwd,
        iconMode: codePreviewSettings.pathIcons,
        previewEnabled: codePreviewSettings.findResultPreview,
        collapsedLines: codePreviewSettings.pathListCollapsedLines,
        loadingLabel: "Finding…",
        emptyMarker: "No files found matching pattern",
        emptyLabel: (output) => output || "No files found",
        footerNoun: "paths",
      }),
    ),
  });
}
