import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeTolerantFields, type TolerantFieldDiagnostic } from "pi-cosmic-core";
import {
  ALL_CODE_PREVIEW_TOOLS,
  parseCodePreviewTools,
  parseToolToggleId,
  type CodePreviewToolName,
} from "../tools/names";
import { formatToolsSettingValue, getEffectiveCodePreviewTools } from "../tools/policy";
import { defaultCodePreviewSettings } from "./defaults";
import {
  CodePreviewSettingsSchema,
  ToolCallBackgroundModeSchema,
  type CodePreviewEditableSettingId,
  type CodePreviewSettings,
  type ToolCallBackgroundMode,
} from "./schema";
import { cloneCodePreviewSettings, codePreviewSettings } from "./state";

export const ON_OFF_VALUES = ["on", "off"] as const;
export type OnOffValue = (typeof ON_OFF_VALUES)[number];

const MAX_SETTINGS_DIAGNOSTICS = 16;

export interface NormalizedCodePreviewSettings {
  readonly settings: CodePreviewSettings;
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
}

export function formatOnOff(value: boolean): OnOffValue {
  return value ? "on" : "off";
}

export function isToolCallBackgroundMode<ValueInput>(
  value: ValueInput,
): value is ValueInput & ToolCallBackgroundMode {
  return Schema.is(ToolCallBackgroundModeSchema)(value);
}

export function formatSettingValue(
  settings: CodePreviewSettings,
  id: CodePreviewEditableSettingId,
): string {
  if (id === "resetToDefaults") return "keep current";
  if (id === "tools") return formatToolsSettingValue(settings.tools);
  const value = settings[id];
  if (Predicate.isBoolean(value)) return formatOnOff(value);
  return String(value);
}

export function normalizeSettingsWithDiagnostics<DataInput>(
  data: DataInput,
  fallback: CodePreviewSettings = codePreviewSettings,
): NormalizedCodePreviewSettings {
  const decoded = decodeTolerantFields(data, CodePreviewSettingsSchema.fields, {
    path: "settings",
    maxDiagnostics: MAX_SETTINGS_DIAGNOSTICS,
  });
  const next = cloneCodePreviewSettings(fallback);
  Object.assign(next, decoded.value);
  next.tools = decoded.value.tools ? [...new Set(decoded.value.tools)] : [...fallback.tools];
  return {
    settings: withRequiredToolRenderers(next),
    diagnostics: decoded.diagnostics,
  };
}

function parseUiSettingValue<K extends keyof CodePreviewSettings>(
  current: CodePreviewSettings,
  key: K,
  value: string,
): CodePreviewSettings[K] | undefined {
  const currentValue = current[key];
  let candidate: unknown = value;
  if (key === "tools") {
    const tools = parseCodePreviewTools(value);
    candidate = tools ? [...tools] : undefined;
  } else if (key === "editCollapsedLines") {
    candidate = value === "all" ? value : Number(value);
  } else if (Predicate.isBoolean(currentValue)) {
    candidate = value === "on" ? true : value === "off" ? false : undefined;
  } else if (Predicate.isNumber(currentValue)) {
    candidate = Number(value);
  }
  const decoded = Schema.decodeUnknownOption(CodePreviewSettingsSchema.fields[key])(candidate);
  // SAFETY: The selected authoritative field schema corresponds to the requested settings key.
  return Option.isSome(decoded) ? (decoded.value as CodePreviewSettings[K]) : undefined;
}

function setSetting<K extends keyof CodePreviewSettings>(
  settings: CodePreviewSettings,
  key: K,
  value: CodePreviewSettings[K],
): void {
  settings[key] = value;
}

export function updateSetting(
  current: CodePreviewSettings,
  id: string,
  value: string,
): CodePreviewSettings {
  if (id === "resetToDefaults" && value === "reset now")
    return cloneCodePreviewSettings(defaultCodePreviewSettings);

  const next = cloneCodePreviewSettings(current);
  if (Object.hasOwn(CodePreviewSettingsSchema.fields, id)) {
    // SAFETY: The own-property check narrows id to a field in the authoritative settings schema.
    const key = id as keyof CodePreviewSettings;
    const parsed = parseUiSettingValue(current, key, value);
    if (parsed !== undefined) setSetting(next, key, parsed);
  } else {
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
