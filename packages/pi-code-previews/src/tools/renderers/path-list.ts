import * as Predicate from "effect/Predicate";
import { Text } from "@earendil-works/pi-tui";
import { renderDisplayPath } from "../../paths/display";
import { trimSingleTrailingNewline } from "../../preview/format";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { getTextContent } from "../data/results";
import { createPathListRenderer } from "../path-list-render";
import { renderCodePreviewToolTitle } from "../presentation";
import { splitListingNotice, withAgentNotes } from "./shared/output-notice";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderResultPrelude } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";

/** Find and ls present one path listing; only their wording and preview setting differ. */
const PATH_LISTS = {
  find: {
    previewEnabled: () => codePreviewSettings.findResultPreview,
    loadingLabel: "Finding…",
    emptyMarker: "No files found matching pattern",
    emptyLabel: (output: string) => output || "No files found",
    footerNoun: "paths",
  },
  ls: {
    previewEnabled: () => codePreviewSettings.lsResultPreview,
    loadingLabel: "Listing…",
    emptyMarker: "(empty directory)",
    emptyLabel: () => "Empty directory",
    footerNoun: "entries",
  },
};

export function pathListPreviewRenderers(tool: "find" | "ls", cwd: string): PreviewRenderers {
  const config = PATH_LISTS[tool];
  return {
    renderCall(args, theme) {
      const pattern = Predicate.isString(args.pattern) ? args.pattern : "";
      const path = Predicate.isString(args.path) && args.path ? args.path : ".";
      // Find names its pattern before the folder it searches; ls names only the folder.
      const search =
        tool === "find"
          ? `${theme.fg("accent", escapeControlChars(pattern || "*"))} ${theme.fg("muted", "in")} `
          : "";
      return new Text(
        `${renderCodePreviewToolTitle(tool, theme)} ${search}${renderDisplayPath(path, cwd, theme)}`,
        0,
        0,
      );
    },

    renderResult: (result, { expanded, isPartial }, theme, { isError, state }) => {
      const output = trimSingleTrailingNewline(getTextContent(result.content));
      const prelude = renderResultPrelude({
        isPartial,
        theme,
        loadingLabel: config.loadingLabel,
        isError,
        expanded,
        errorText: output,
      });
      if (prelude) return prelude;
      const previewEnabled = config.previewEnabled();
      if (!expanded && !previewEnabled)
        return renderHiddenPreviewExpandHint(state, theme, config.footerNoun);
      if (!output || output === config.emptyMarker)
        return new Text(theme.fg("muted", config.emptyLabel(output)), 0, 0);
      const { lines: rawLines, notice } = splitListingNotice(output.split("\n"));
      const notes = expanded ? notice : undefined;
      if (expanded && !previewEnabled)
        return withAgentNotes(
          new Text(
            rawLines.map((line) => theme.fg("toolOutput", escapeControlChars(line))).join("\n"),
            0,
            0,
          ),
          theme,
          notes,
        );

      const limit = expanded ? rawLines.length : codePreviewSettings.pathListCollapsedLines;
      const pathList = createPathListRenderer(rawLines, cwd, theme, codePreviewSettings.pathIcons);
      const text = renderSelectedOutputLines(
        pathList.lines,
        limit,
        theme,
        config.footerNoun,
        pathList.renderChunk,
      );
      return withAgentNotes(new Text(text, 0, 0), theme, notes);
    },
  };
}
