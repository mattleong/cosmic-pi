import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeTolerantFields, type TolerantFieldDiagnostic } from "pi-cosmic-core";
import { ALL_CODE_PREVIEW_TOOLS, parseCodePreviewTools } from "../tools/names";
import {
  CODE_PREVIEW_SETTING_KEYS,
  CodePreviewSettingsSchema,
  type CodePreviewEditableSettingId,
  type CodePreviewSettings,
} from "./schema";
import { cloneCodePreviewSettings } from "./state";

export const ON_OFF_VALUES = ["on", "off"] as const;

const MAX_SETTINGS_DIAGNOSTICS = 16;

interface NormalizedCodePreviewSettings {
  readonly settings: CodePreviewSettings;
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
}

export function formatOnOff(value: boolean): (typeof ON_OFF_VALUES)[number] {
  return value ? "on" : "off";
}

export function formatSettingValue(
  settings: CodePreviewSettings,
  id: CodePreviewEditableSettingId,
): string {
  if (id === "resetToDefaults") return "keep current";
  const value = settings[id];
  if (Predicate.isBoolean(value)) return formatOnOff(value);
  return String(value);
}

export function normalizeSettingsWithDiagnostics<DataInput>(
  data: DataInput,
  fallback: CodePreviewSettings,
): NormalizedCodePreviewSettings {
  const decoded = decodeTolerantFields(data, CodePreviewSettingsSchema.fields, {
    path: "settings",
    maxDiagnostics: MAX_SETTINGS_DIAGNOSTICS,
  });
  const next = cloneCodePreviewSettings(fallback);
  Object.assign(next, decoded.value);
  const tools = new Set(decoded.value.tools ?? fallback.tools);
  next.tools = ALL_CODE_PREVIEW_TOOLS.filter((tool) => tools.has(tool));
  return { settings: next, diagnostics: decoded.diagnostics };
}

type SettingKey = keyof CodePreviewSettings;
type SettingCandidate = string | number | boolean | CodePreviewSettings["tools"] | undefined;

function uiSettingCandidate(
  key: SettingKey,
  currentValue: CodePreviewSettings[SettingKey],
  value: string,
): SettingCandidate {
  if (key === "tools") {
    const tools = parseCodePreviewTools(value);
    return tools ? [...tools] : undefined;
  }
  if (key === "editCollapsedLines") return value === "all" ? value : Number(value);
  if (Predicate.isBoolean(currentValue))
    return value === "on" ? true : value === "off" ? false : undefined;
  if (Predicate.isNumber(currentValue)) return Number(value);
  return value;
}

export function updateSetting(
  current: CodePreviewSettings,
  id: string,
  value: string,
): CodePreviewSettings {
  const key = CODE_PREVIEW_SETTING_KEYS.find((candidate) => candidate === id);
  if (!key) return cloneCodePreviewSettings(current);
  const decoded = Schema.decodeOption(CodePreviewSettingsSchema)({
    ...current,
    [key]: uiSettingCandidate(key, current[key], value),
  });
  return Option.isSome(decoded)
    ? { ...decoded.value, tools: [...decoded.value.tools] }
    : cloneCodePreviewSettings(current);
}
