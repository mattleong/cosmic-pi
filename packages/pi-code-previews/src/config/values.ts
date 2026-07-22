import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ALL_CODE_PREVIEW_TOOLS,
  parseCodePreviewTools,
  parseToolToggleId,
  type CodePreviewToolName,
} from "../tools/names";
import { formatToolsSettingValue, getEffectiveCodePreviewTools } from "../tools/policy";
import {
  CODE_PREVIEW_SETTING_DEFINITIONS,
  CODE_PREVIEW_SETTING_KEYS,
  getSettingDefinition,
  type CodePreviewSettingDescriptor,
} from "./definitions";
import { defaultCodePreviewSettings } from "./defaults";
import { cloneCodePreviewSettings, codePreviewSettings } from "./state";
import type { CodePreviewEditableSettingId, CodePreviewSettings } from "./schema";

export const ON_OFF_VALUES = ["on", "off"] as const;
export type OnOffValue = (typeof ON_OFF_VALUES)[number];

export function formatOnOff(value: boolean): OnOffValue {
  return value ? "on" : "off";
}

export { isToolCallBackgroundMode, parseToolCallBackgroundMode } from "./schema";

export function formatSettingValue(
  settings: CodePreviewSettings,
  id: CodePreviewEditableSettingId,
): string {
  if (id === "resetToDefaults") return "keep current";
  if (id === "tools") return formatToolsSettingValue(settings.tools);
  const value = settings[id];
  if (typeof value === "boolean") return formatOnOff(value);
  return String(value);
}

export function normalizeSettings(
  data: unknown,
  fallback: CodePreviewSettings = codePreviewSettings,
): CodePreviewSettings {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(data),
    () => ({}),
  );
  const next = {} as CodePreviewSettings;
  for (const key of CODE_PREVIEW_SETTING_KEYS) normalizeSetting(next, decoded, fallback, key);
  return withRequiredToolRenderers(next);
}

function normalizeSetting<K extends keyof CodePreviewSettings>(
  next: CodePreviewSettings,
  data: Readonly<Record<string, unknown>>,
  fallback: CodePreviewSettings,
  key: K,
): void {
  const definition = CODE_PREVIEW_SETTING_DEFINITIONS[
    key
  ] as unknown as CodePreviewSettingDescriptor<K>;
  const raw = legacySettingValue(key, data[key]);
  const decoded = Schema.decodeUnknownOption(definition.schema)(raw);
  next[key] = Option.isSome(decoded)
    ? definition.normalize(decoded.value, fallback[key])
    : fallback[key];
}

function legacySettingValue<K extends keyof CodePreviewSettings>(key: K, value: unknown): unknown {
  if (key === "toolCallBackground" && typeof value === "boolean") return value ? "on" : "off";
  if (key === "tools" && typeof value === "string") return parseToolsForSchema(value);
  return value;
}

function parseToolsForSchema(value: string): readonly CodePreviewToolName[] | undefined {
  const parsed = parseCodePreviewTools(value);
  return parsed ? [...parsed] : undefined;
}

export function updateSetting(
  current: CodePreviewSettings,
  id: string,
  value: string,
): CodePreviewSettings {
  if (id === "resetToDefaults" && value === "reset now")
    return cloneCodePreviewSettings(defaultCodePreviewSettings);

  const next = cloneCodePreviewSettings(current);
  const definition = getSettingDefinition(id);
  if (definition) definition.update(next, current, value);
  else {
    const tool = parseToolToggleId(id);
    if (tool) next.tools = updateToolToggle(current.tools, tool, value);
  }
  return withRequiredToolRenderers(next);
}

function withRequiredToolRenderers(settings: CodePreviewSettings): CodePreviewSettings {
  return {
    ...settings,
    tools: getEffectiveCodePreviewTools(settings.tools, settings),
  };
}

function updateToolToggle(
  currentTools: CodePreviewToolName[],
  tool: CodePreviewToolName,
  value: string,
): CodePreviewToolName[] {
  const enabled = new Set(currentTools);
  if (value === "on") enabled.add(tool);
  else if (value === "off") enabled.delete(tool);
  return ALL_CODE_PREVIEW_TOOLS.filter((candidate) => enabled.has(candidate));
}
