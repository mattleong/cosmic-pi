import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { CodePreviewRendererSession } from "../../application/renderer-contract";
import { Text } from "@earendil-works/pi-tui";

import { renderDisplayPath } from "../../paths/display";
import { codePreviewSettings } from "../../config/state";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewRenderers } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { renderPathListResult } from "./shared/path-list-result";

export function createLsPreviewTool(
  cwd: string,
  session?: Pick<CodePreviewRendererSession, "scheduleAnimation" | "selfShell">,
) {
  return createCodePreviewRenderers(
    { name: "ls" },
    {
      ...session,
      selfShell: true,
      compactSummary: (input) => createBuiltinCompactSummary("ls", input),
      expandedContent: builtinExpandedContent("ls", cwd),
      renderCall(args, theme) {
        const path = Predicate.isString(args.path) && args.path ? args.path : ".";
        return new Text(
          `${renderCodePreviewToolTitle("ls", theme)} ${renderDisplayPath(path, cwd, theme)}`,
          0,
          0,
        );
      },
      renderResult: (result, options, theme, renderContext) =>
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
    },
  );
}
