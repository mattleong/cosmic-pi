import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import {
  decodeTolerantFields,
  type JsonObject,
  type TolerantFieldDiagnostic,
} from "pi-cosmic-core";
import {
  ALL_CODE_PREVIEW_TOOLS,
  parseCodePreviewTools,
  type CodePreviewToolName,
} from "../tools/names";
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

// Tools decode per entry so one unknown name cannot discard the whole selection.
const decodeSettingsFields = decodeTolerantFields(
  { ...CodePreviewSettingsSchema.fields, tools: Schema.Array(Schema.Unknown) },
  { path: "settings", maxDiagnostics: MAX_SETTINGS_DIAGNOSTICS },
);
const decodeToolName = Schema.decodeUnknownOption(Schema.Literals(ALL_CODE_PREVIEW_TOOLS));

function decodeToolEntries(entries: readonly unknown[]) {
  const tools = new Set<CodePreviewToolName>();
  const diagnostics: TolerantFieldDiagnostic[] = [];
  Arr.forEach(entries, (entry, index) => {
    const tool = decodeToolName(entry);
    if (Option.isSome(tool)) tools.add(tool.value);
    else diagnostics.push({ path: `settings.tools[${index}]`, issue: "invalid" });
  });
  // Like the CLI parser, a selection with no known names keeps the fallback.
  return { tools: entries.length > 0 && tools.size === 0 ? undefined : tools, diagnostics };
}

export function normalizeSettingsWithDiagnostics(
  data: JsonObject,
  fallback: CodePreviewSettings,
): NormalizedCodePreviewSettings {
  const decoded = decodeSettingsFields(data);
  const next = cloneCodePreviewSettings(fallback);
  Object.assign(next, decoded.value);
  const entries = decoded.value.tools ? decodeToolEntries(decoded.value.tools) : undefined;
  const tools = entries?.tools ?? new Set(fallback.tools);
  next.tools = Arr.filter(ALL_CODE_PREVIEW_TOOLS, (tool) => tools.has(tool));
  const diagnostics = [...decoded.diagnostics, ...(entries?.diagnostics ?? [])];
  return { settings: next, diagnostics: diagnostics.slice(0, MAX_SETTINGS_DIAGNOSTICS) };
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
    return Match.value(value).pipe(
      Match.when("on", () => true),
      Match.when("off", () => false),
      Match.orElse(() => undefined),
    );
  if (Predicate.isNumber(currentValue)) return Number(value);
  return value;
}

export function updateSetting(
  current: CodePreviewSettings,
  id: string,
  value: string,
): CodePreviewSettings {
  const key = Option.getOrUndefined(
    Arr.findFirst(CODE_PREVIEW_SETTING_KEYS, (candidate) => candidate === id),
  );
  if (!key) return cloneCodePreviewSettings(current);
  const decoded = Schema.decodeOption(CodePreviewSettingsSchema)({
    ...current,
    [key]: uiSettingCandidate(key, current[key], value),
  });
  return Option.isSome(decoded)
    ? { ...decoded.value, tools: [...decoded.value.tools] }
    : cloneCodePreviewSettings(current);
}
