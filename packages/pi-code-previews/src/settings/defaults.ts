import { bundledThemes } from "shiki";
import type { CodePreviewEnvironment } from "../config/env";
import { parseBoolean, parsePositiveInteger } from "../config/env";
import { ALL_CODE_PREVIEW_TOOLS } from "../tools/names";
import { parseToolCallBackgroundMode } from "./tool-call-background";
import type { CodePreviewSettings } from "./types";
import {
  DIFF_BACKGROUND_INTENSITIES,
  DIFF_WORD_EMPHASES,
  PATH_ICON_MODES,
} from "./schema-constants";

export const defaultCodePreviewSettings: CodePreviewSettings = Object.freeze({
  shikiTheme: "dark-plus",
  diffIntensity: "subtle",
  wordEmphasis: "all",
  toolCallBackground: "on",
  toolCallTiming: true,
  readCollapsedLines: 10,
  readContentPreview: true,
  writeContentPreview: true,
  writeCollapsedLines: 10,
  editDiffPreview: true,
  editCollapsedLines: 160,
  grepCollapsedLines: 15,
  grepResultPreview: true,
  findResultPreview: true,
  lsResultPreview: true,
  pathListCollapsedLines: 20,
  readLineNumbers: true,
  bashResultPreview: true,
  bashWarnings: true,
  syntaxHighlighting: true,
  secretWarnings: true,
  pathIcons: "unicode",
  tools: Object.freeze([...ALL_CODE_PREVIEW_TOOLS]),
}) as CodePreviewSettings;

function environmentOption<T extends string>(
  raw: string | undefined,
  values: readonly T[],
  fallback: T,
): T {
  const normalized = raw?.toLowerCase();
  return normalized && (values as readonly string[]).includes(normalized)
    ? (normalized as T)
    : fallback;
}

export function defaultsFromEnvironment(environment: CodePreviewEnvironment): CodePreviewSettings {
  const value = (name: keyof CodePreviewEnvironment) => environment[name];
  const boolean = (name: keyof CodePreviewEnvironment, fallback: boolean) =>
    parseBoolean(value(name)) ?? fallback;
  const integer = (name: keyof CodePreviewEnvironment, fallback: number) =>
    parsePositiveInteger(value(name)) ?? fallback;
  const theme = value("CODE_PREVIEW_THEME");
  const editLines = value("CODE_PREVIEW_EDIT_LINES");
  return {
    shikiTheme: theme && theme in bundledThemes ? theme : "dark-plus",
    diffIntensity: environmentOption(
      value("CODE_PREVIEW_DIFF_INTENSITY"),
      DIFF_BACKGROUND_INTENSITIES,
      "subtle",
    ),
    wordEmphasis: environmentOption(value("CODE_PREVIEW_WORD_EMPHASIS"), DIFF_WORD_EMPHASES, "all"),
    toolCallBackground:
      parseToolCallBackgroundMode(value("CODE_PREVIEW_TOOL_CALL_BACKGROUND")) ?? "on",
    toolCallTiming: boolean("CODE_PREVIEW_TOOL_CALL_TIMING", true),
    readCollapsedLines: integer("CODE_PREVIEW_READ_LINES", 10),
    readContentPreview: boolean("CODE_PREVIEW_READ_CONTENT", true),
    writeContentPreview: boolean("CODE_PREVIEW_WRITE_CONTENT", true),
    writeCollapsedLines: integer("CODE_PREVIEW_WRITE_LINES", 10),
    editDiffPreview: boolean("CODE_PREVIEW_EDIT_DIFF", true),
    editCollapsedLines: editLines === "all" ? "all" : (parsePositiveInteger(editLines) ?? 160),
    grepCollapsedLines: integer("CODE_PREVIEW_GREP_LINES", 15),
    grepResultPreview: boolean("CODE_PREVIEW_GREP_RESULTS", true),
    findResultPreview: boolean("CODE_PREVIEW_FIND_RESULTS", true),
    lsResultPreview: boolean("CODE_PREVIEW_LS_RESULTS", true),
    pathListCollapsedLines: integer("CODE_PREVIEW_PATH_LIST_LINES", 20),
    readLineNumbers: boolean("CODE_PREVIEW_READ_LINE_NUMBERS", true),
    bashResultPreview: boolean("CODE_PREVIEW_BASH_RESULTS", true),
    bashWarnings: boolean("CODE_PREVIEW_BASH_WARNINGS", true),
    syntaxHighlighting: boolean("CODE_PREVIEW_SYNTAX", true),
    secretWarnings: boolean("CODE_PREVIEW_SECRET_WARNINGS", true),
    pathIcons: environmentOption(value("CODE_PREVIEW_PATH_ICONS"), PATH_ICON_MODES, "unicode"),
    tools: [...ALL_CODE_PREVIEW_TOOLS],
  };
}
