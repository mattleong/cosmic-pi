import * as Predicate from "effect/Predicate";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { renderDisplayPath } from "../../paths/display";
import { codePreviewSettings } from "../../config/state";
import { renderCodePreviewToolTitle } from "../presentation";
import { registerPathListTool } from "./shared/path-list-tool";

export function registerLs(pi: ExtensionAPI, cwd: string) {
  registerPathListTool(pi, cwd, {
    createToolDefinition: createLsToolDefinition,
    renderCall(args, theme, renderCwd) {
      const path = Predicate.isString(args.path) && args.path ? args.path : ".";
      return new Text(
        `${renderCodePreviewToolTitle("ls", theme)} ${renderDisplayPath(path, renderCwd, theme)}`,
        0,
        0,
      );
    },
    resultConfig: (renderCwd) => ({
      cwd: renderCwd,
      iconMode: codePreviewSettings.pathIcons,
      previewEnabled: codePreviewSettings.lsResultPreview,
      collapsedLines: codePreviewSettings.pathListCollapsedLines,
      loadingLabel: "Listing…",
      errorLabel: "List failed",
      emptyMarker: "(empty directory)",
      emptyLabel: () => "Empty directory",
      footerNoun: "entries",
    }),
  });
}
