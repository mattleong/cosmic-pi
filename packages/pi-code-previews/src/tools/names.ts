import * as Schema from "effect/Schema";

export const CORE_CODE_PREVIEW_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
] as const;

export const ALL_CODE_PREVIEW_TOOLS = [
  ...CORE_CODE_PREVIEW_TOOLS,
  "codemode",
  "tool_search",
] as const;

export type CodePreviewToolName = (typeof ALL_CODE_PREVIEW_TOOLS)[number];

const CODE_PREVIEW_TOOL_TOGGLE_ID_PREFIX = "tool:";

export const isCodePreviewToolName = Schema.is(Schema.Literals(ALL_CODE_PREVIEW_TOOLS));

export function toolToggleId(tool: CodePreviewToolName): string {
  return `${CODE_PREVIEW_TOOL_TOGGLE_ID_PREFIX}${tool}`;
}

export function parseToolToggleId(id: string): CodePreviewToolName | undefined {
  const tool = id.startsWith(CODE_PREVIEW_TOOL_TOGGLE_ID_PREFIX)
    ? id.slice(CODE_PREVIEW_TOOL_TOGGLE_ID_PREFIX.length)
    : "";
  return isCodePreviewToolName(tool) ? tool : undefined;
}

export function parseCodePreviewTools(
  raw: string | undefined,
): Set<CodePreviewToolName> | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "none") return new Set();
  const enabled = new Set(trimmed.split(/[\s,]+/).filter(isCodePreviewToolName));
  return enabled.size > 0 ? enabled : undefined;
}
