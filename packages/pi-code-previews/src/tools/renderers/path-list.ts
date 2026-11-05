import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Text } from "@earendil-works/pi-tui";
import { renderDisplayPath } from "../../paths/display";
import { metadata, trimSingleTrailingNewline } from "../../preview/format";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { escapeControlChars } from "../../shared/terminal-text";
import { numericArg, stringArg } from "../data/args";
import { getTextContent } from "../data/results";
import { createPathListRenderer } from "../path-list-render";
import { renderCodePreviewToolTitle } from "../presentation";
import { splitListingNotice, withAgentNotes, withCollapsedLimit } from "./shared/output-notice";
import { renderSelectedOutputLines } from "./shared/preview-text";
import { renderResultPrelude } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";
import { previewHeadingText } from "../../preview/heading-wrap";
import { PATH_LIST_EMPTY_OUTPUT } from "../builtin-result-detail";
import { hostObject } from "../../shared/untrusted-value";

const PATH_LISTS = {
  find: {
    previewEnabled: () => codePreviewSettings.findResultPreview,
    loadingLabel: "Finding…",
    emptyMarker: PATH_LIST_EMPTY_OUTPUT.find,
    emptyLabel: (output: string) => output || "No files found",
    footerNoun: "paths",
    footerItem: { singular: "path" },
  },
  ls: {
    previewEnabled: () => codePreviewSettings.lsResultPreview,
    loadingLabel: "Listing…",
    emptyMarker: PATH_LIST_EMPTY_OUTPUT.ls,
    emptyLabel: () => "Empty directory",
    footerNoun: "entries",
    footerItem: { singular: "entry", plural: "entries" },
  },
};

export function pathListPreviewRenderers(tool: "find" | "ls", cwd: string): PreviewRenderers {
  const config = PATH_LISTS[tool];
  return {
    renderCall(args, theme) {
      const input = hostObject(args);
      const pattern = stringArg(input, "pattern");
      const path = stringArg(input, "path") || ".";
      const search =
        tool === "find"
          ? `${theme.fg("accent", escapeControlChars(pattern || "*"))} ${theme.fg("muted", "in")} `
          : "";
      const limit = numericArg(input, "limit");
      const text = `${renderCodePreviewToolTitle(tool, theme)} ${search}${renderDisplayPath(path, cwd, theme)}${metadata(theme, [limit ? `limit ${limit}` : undefined])}`;
      return previewHeadingText(() => text);
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
      const { lines: rawLines, notice } = splitListingNotice(Str.split(output, "\n"));
      const notes = expanded ? notice : undefined;
      if (expanded && !previewEnabled)
        return withAgentNotes(
          new Text(
            Arr.join(
              Arr.map(rawLines, (line) => theme.fg("toolOutput", escapeControlChars(line))),
              "\n",
            ),
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
        config.footerItem,
        pathList.renderChunk,
      );
      const shown = expanded
        ? text
        : withCollapsedLimit(text, theme, tool, hostObject(result.details), notice);
      return withAgentNotes(new Text(shown, 0, 0), theme, notes);
    },
  };
}
