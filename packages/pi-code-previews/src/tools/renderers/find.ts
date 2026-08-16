import * as Predicate from "effect/Predicate";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { renderDisplayPath } from "../../paths/display";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { renderCodePreviewToolTitle } from "../presentation";
import { registerPathListTool } from "./shared/path-list-tool";

export function registerFind(pi: ExtensionAPI, cwd: string) {
  registerPathListTool(pi, cwd, {
    createToolDefinition: createFindToolDefinition,
    renderCall(args, theme, renderCwd) {
      const pattern = Predicate.isString(args.pattern) ? args.pattern : "";
      const path = Predicate.isString(args.path) && args.path ? args.path : ".";
      return new Text(
        `${renderCodePreviewToolTitle("find", theme)} ${theme.fg("accent", escapeControlChars(pattern || "*"))} ${theme.fg("muted", "in")} ${renderDisplayPath(path, renderCwd, theme)}`,
        0,
        0,
      );
    },
    resultConfig: (renderCwd) => ({
      cwd: renderCwd,
      iconMode: codePreviewSettings.pathIcons,
      previewEnabled: codePreviewSettings.findResultPreview,
      collapsedLines: codePreviewSettings.pathListCollapsedLines,
      loadingLabel: "Finding…",
      errorLabel: "Find failed",
      emptyMarker: "No files found matching pattern",
      emptyLabel: (output) => output || "No files found",
      footerNoun: "paths",
    }),
  });
}
