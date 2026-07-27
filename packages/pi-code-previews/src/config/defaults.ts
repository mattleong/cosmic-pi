import { bundledThemes } from "shiki";
import type { CodePreviewEnvironment } from "./env";
import { parseBoolean, parsePositiveInteger } from "./env";
import { ALL_CODE_PREVIEW_TOOLS } from "../tools/names";
import {
  DIFF_BACKGROUND_INTENSITIES,
  DIFF_WORD_EMPHASES,
  PATH_ICON_MODES,
  parseToolCallBackgroundMode,
  type CodePreviewSettings,
} from "./schema";

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

/** Every fallback below is read from `defaultCodePreviewSettings`, never repeated as a literal. */
export function defaultsFromEnvironment(environment: CodePreviewEnvironment): CodePreviewSettings {
  const fallback = defaultCodePreviewSettings;
  const value = (name: keyof CodePreviewEnvironment) => environment[name];
  const boolean = <K extends keyof CodePreviewSettings>(
    name: keyof CodePreviewEnvironment,
    key: K,
  ) => parseBoolean(value(name)) ?? (fallback[key] as boolean);
  const integer = <K extends keyof CodePreviewSettings>(
    name: keyof CodePreviewEnvironment,
    key: K,
  ) => parsePositiveInteger(value(name)) ?? (fallback[key] as number);
  const theme = value("CODE_PREVIEW_THEME");
  const editLines = value("CODE_PREVIEW_EDIT_LINES");
  return {
    shikiTheme: theme && theme in bundledThemes ? theme : fallback.shikiTheme,
    diffIntensity: environmentOption(
      value("CODE_PREVIEW_DIFF_INTENSITY"),
      DIFF_BACKGROUND_INTENSITIES,
      fallback.diffIntensity,
    ),
    wordEmphasis: environmentOption(
      value("CODE_PREVIEW_WORD_EMPHASIS"),
      DIFF_WORD_EMPHASES,
      fallback.wordEmphasis,
    ),
    toolCallBackground:
      parseToolCallBackgroundMode(value("CODE_PREVIEW_TOOL_CALL_BACKGROUND")) ??
      fallback.toolCallBackground,
    toolCallTiming: boolean("CODE_PREVIEW_TOOL_CALL_TIMING", "toolCallTiming"),
    readCollapsedLines: integer("CODE_PREVIEW_READ_LINES", "readCollapsedLines"),
    readContentPreview: boolean("CODE_PREVIEW_READ_CONTENT", "readContentPreview"),
    writeContentPreview: boolean("CODE_PREVIEW_WRITE_CONTENT", "writeContentPreview"),
    writeCollapsedLines: integer("CODE_PREVIEW_WRITE_LINES", "writeCollapsedLines"),
    editDiffPreview: boolean("CODE_PREVIEW_EDIT_DIFF", "editDiffPreview"),
    editCollapsedLines:
      editLines === "all"
        ? "all"
        : (parsePositiveInteger(editLines) ?? fallback.editCollapsedLines),
    grepCollapsedLines: integer("CODE_PREVIEW_GREP_LINES", "grepCollapsedLines"),
    grepResultPreview: boolean("CODE_PREVIEW_GREP_RESULTS", "grepResultPreview"),
    findResultPreview: boolean("CODE_PREVIEW_FIND_RESULTS", "findResultPreview"),
    lsResultPreview: boolean("CODE_PREVIEW_LS_RESULTS", "lsResultPreview"),
    pathListCollapsedLines: integer("CODE_PREVIEW_PATH_LIST_LINES", "pathListCollapsedLines"),
    readLineNumbers: boolean("CODE_PREVIEW_READ_LINE_NUMBERS", "readLineNumbers"),
    bashResultPreview: boolean("CODE_PREVIEW_BASH_RESULTS", "bashResultPreview"),
    bashWarnings: boolean("CODE_PREVIEW_BASH_WARNINGS", "bashWarnings"),
    syntaxHighlighting: boolean("CODE_PREVIEW_SYNTAX", "syntaxHighlighting"),
    secretWarnings: boolean("CODE_PREVIEW_SECRET_WARNINGS", "secretWarnings"),
    pathIcons: environmentOption(
      value("CODE_PREVIEW_PATH_ICONS"),
      PATH_ICON_MODES,
      fallback.pathIcons,
    ),
    tools: [...fallback.tools],
  };
}
