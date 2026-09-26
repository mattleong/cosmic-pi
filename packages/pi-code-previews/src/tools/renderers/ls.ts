import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { renderDisplayPath } from "../../paths/display";
import { codePreviewSettings } from "../../config/state";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewToolDefinition } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { renderPathListResult } from "./shared/path-list-result";
import { withPreviewIssues } from "./shared/preview-issues";

export function createLsPreviewTool(cwd: string) {
  const originalLs = createLsToolDefinition(cwd);

  return createCodePreviewToolDefinition(originalLs, {
    compactSummary: (input) => createBuiltinCompactSummary("ls", input),
    expandedContent: builtinExpandedContent<typeof originalLs>("ls", cwd),
    renderCall(args, theme) {
      const path = Predicate.isString(args.path) && args.path ? args.path : ".";
      return new Text(
        `${renderCodePreviewToolTitle("ls", theme)} ${renderDisplayPath(path, cwd, theme)}`,
        0,
        0,
      );
    },
    renderResult: withPreviewIssues("ls", (result, options, theme, renderContext) =>
      renderPathListResult(result, options, theme, renderContext, {
        cwd,
        iconMode: codePreviewSettings.pathIcons,
        previewEnabled: codePreviewSettings.lsResultPreview,
        collapsedLines: codePreviewSettings.pathListCollapsedLines,
        loadingLabel: "Listing…",
        emptyMarker: "(empty directory)",
        emptyLabel: () => "Empty directory",
        footerNoun: "entries",
      }),
    ),
  });
}
