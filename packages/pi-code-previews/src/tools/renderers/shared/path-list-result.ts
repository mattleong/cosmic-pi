import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { getTextContent } from "../../data/results";
import { showingFooter, trimSingleTrailingNewline } from "../../../preview/format";
import { createPathListRenderer } from "../../../tools/path-list-render";
import { escapeControlChars } from "../../../shared/terminal-text";
import { splitListingNotice, withAgentNotes } from "./output-notice";
import { renderSelectedOutputLines } from "./preview-text";
import { renderResultPrelude } from "./result-prelude";
import { renderHiddenPreviewExpandHint } from "../../../preview/bordered-tool-call";
import type { PathIconMode } from "../../../config/schema";
import type { RendererState } from "./types";

export interface PathListResultConfig {
  cwd: string;
  iconMode: PathIconMode;
  previewEnabled: boolean;
  loadingLabel: string;
  emptyMarker: string;
  emptyLabel: (output: string) => string;
  collapsedLines: number;
  footerNoun: string;
}

interface PathListRenderContext {
  isError: boolean;
  state: RendererState;
}

export function renderPathListResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context: PathListRenderContext,
  config: PathListResultConfig,
): Component {
  const output = trimSingleTrailingNewline(getTextContent(result.content));
  const prelude = renderResultPrelude({
    isPartial,
    theme,
    loadingLabel: config.loadingLabel,
    isError: context.isError,
    expanded,
    errorText: output,
  });
  if (prelude) return prelude;
  if (!expanded && !config.previewEnabled)
    return renderHiddenPreviewExpandHint(context.state, theme, config.footerNoun);
  if (!output || output === config.emptyMarker)
    return new Text(theme.fg("muted", config.emptyLabel(output)), 0, 0);
  const { lines: rawLines, notice } = splitListingNotice(output.split("\n"));
  const notes = expanded ? notice : undefined;
  if (expanded && !config.previewEnabled)
    return withAgentNotes(
      new Text(
        rawLines.map((line) => theme.fg("toolOutput", escapeControlChars(line))).join("\n"),
        0,
        0,
      ),
      theme,
      notes,
    );

  const limit = expanded ? rawLines.length : config.collapsedLines;
  const pathList = createPathListRenderer(rawLines, config.cwd, theme, {
    iconMode: config.iconMode,
  });
  const preview = renderSelectedOutputLines(pathList.lines, limit, theme, pathList.renderChunk);
  let text = preview.lines.join("\n");
  if (preview.hidden > 0)
    text += showingFooter(theme, preview.shown, rawLines.length, config.footerNoun);
  return withAgentNotes(new Text(text, 0, 0), theme, notes);
}
