import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  JsonDocumentError,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { currentWorkingDirectory } from "../boundary/environment";
import { CODE_PREVIEW_SETTING_KEYS } from "./definitions";
import { CodePreviewEnvironmentService } from "./environment-service";
import { CodePreviewSettingsSchema } from "./schema";
import { cloneCodePreviewSettings } from "./state";
import type { CodePreviewSettings } from "./types";
import { normalizeSettings } from "./values";

export type SettingsSaveContext = {
  readonly baseline: CodePreviewSettings;
  readonly loaded: CodePreviewSettings;
  readonly globalOverrides: Readonly<JsonObject>;
  readonly globalDocument: JsonObject;
  readonly nested: boolean;
};

export type LoadedSettingsState = {
  readonly settings: CodePreviewSettings | undefined;
  readonly saveContext: SettingsSaveContext;
};

export class CodePreviewSettingsLoadError extends Schema.TaggedErrorClass<CodePreviewSettingsLoadError>()(
  "CodePreviewSettingsLoadError",
  {
    reason: Schema.Literals(["malformed", "permission", "document"]),
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type LoadSettingsOptions = {
  projectCwd?: string;
  projectTrusted?: boolean;
};

const loadSettingsFile = Effect.fn("CodePreviewSettings.loadFile")(function* (
  settingsPath: string,
  fallback: CodePreviewSettings,
) {
  const documents = yield* JsonDocumentStore;
  const document = yield* documents.readObject(settingsPath).pipe(
    Effect.mapError(
      (error) =>
        new CodePreviewSettingsLoadError({
          reason:
            error.operation === "decode"
              ? "malformed"
              : error.operation === "read" || error.operation === "exists"
                ? "permission"
                : "document",
          operation: "load",
          message: "Unable to load code preview settings.",
        }),
    ),
    Effect.catchTag("CodePreviewSettingsLoadError", () =>
      Effect.logWarning("Failed to load settings for code previews; ignoring that document.").pipe(
        Effect.as(undefined),
      ),
    ),
  );
  if (!document) return undefined;
  const data = extractCodePreviewSettings(document);
  return { document, data, settings: normalizeSettings(data, fallback) };
});

export const loadSettingsStateEffect = Effect.fn("CodePreviewSettings.loadState")(function* (
  options: LoadSettingsOptions = {},
) {
  const path = yield* Path.Path;
  const agentDir = yield* AgentDirectory;
  const environment = yield* CodePreviewEnvironmentService;
  const homeDir = environment.values.HOME ?? path.dirname(path.dirname(agentDir));
  const settingsPath = path.join(agentDir, "code-previews.json");
  const legacyAgentDir = path.join(homeDir, ".pi", "agent");
  const projectCwd = options.projectCwd ?? currentWorkingDirectory();
  let loaded = false;
  let effective = cloneCodePreviewSettings(environment.defaults);
  const baselinePaths = [
    path.join(homeDir, ".pi", "settings.json"),
    path.join(legacyAgentDir, "settings.json"),
    path.join(agentDir, "settings.json"),
    ...(options.projectTrusted ? [path.join(projectCwd, ".pi", "settings.json")] : []),
    path.join(legacyAgentDir, "code-previews.json"),
  ].filter((candidate) => candidate !== settingsPath);
  for (const candidate of new Set(baselinePaths)) {
    const next = yield* loadSettingsFile(candidate, effective);
    if (!next) continue;
    effective = next.settings;
    loaded = true;
  }
  const baseline = cloneCodePreviewSettings(effective);
  const globalSettings = yield* loadSettingsFile(settingsPath, effective);
  if (globalSettings) {
    effective = globalSettings.settings;
    loaded = true;
  }
  return {
    settings: loaded ? effective : undefined,
    saveContext: {
      baseline,
      loaded: cloneCodePreviewSettings(effective),
      globalOverrides: { ...globalSettings?.data },
      globalDocument: { ...globalSettings?.document },
      nested: isRecord(globalSettings?.document.codePreview),
    },
  } satisfies LoadedSettingsState;
});

export const saveSettingsStateEffect = Effect.fn("CodePreviewSettings.saveState")(function* (
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
) {
  const path = yield* Path.Path;
  const agentDir = yield* AgentDirectory;
  const documents = yield* JsonDocumentStore;
  const settingsPath = path.join(agentDir, "code-previews.json");
  const committedSettings = yield* Schema.decodeUnknownEffect(CodePreviewSettingsSchema)(
    settings,
  ).pipe(
    Effect.map(
      (decoded): CodePreviewSettings => ({
        ...decoded,
        tools: [...decoded.tools],
      }),
    ),
    Effect.mapError(
      () =>
        new JsonDocumentError({
          operation: "validate",
          path: settingsPath,
          message: "Code preview settings are invalid.",
        }),
    ),
  );
  const modifyObject = documents.modifyObject;
  if (!modifyObject)
    return yield* new JsonDocumentError({
      operation: "write",
      path: settingsPath,
      message: "Atomic JSON document modification is unavailable.",
    });
  return yield* modifyObject(settingsPath, (latest) =>
    Effect.try({
      try: () => {
        const globalDocument = settingsDocument(committedSettings, {
          ...context,
          globalDocument: latest,
          nested: isRecord(latest.codePreview),
        });
        const nextContext = {
          baseline: cloneCodePreviewSettings(context.baseline),
          loaded: cloneCodePreviewSettings(committedSettings),
          globalOverrides: extractCodePreviewSettings(globalDocument),
          globalDocument,
          nested: isRecord(globalDocument.codePreview),
        } satisfies SettingsSaveContext;
        return {
          value: nextContext,
          document: globalDocument,
          afterCommit: afterCommit(nextContext),
        } satisfies JsonDocumentModification<SettingsSaveContext>;
      },
      catch: () =>
        new JsonDocumentError({
          operation: "write",
          path: settingsPath,
          message: "Unable to update code preview settings.",
        }),
    }),
  );
});

export function getSettingsPathFrom(directory: string): string {
  return `${directory.replace(/[\\/]$/, "")}/code-previews.json`;
}

function settingsOverrides(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
): JsonObject {
  const overrides: JsonObject = { ...context.globalOverrides };
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = settings[key];
    if (settingValuesEqual(value, context.loaded[key])) continue;
    if (settingValuesEqual(value, context.baseline[key])) delete overrides[key];
    else Object.assign(overrides, { [key]: value });
  }
  return overrides;
}

function settingsDocument(settings: CodePreviewSettings, context: SettingsSaveContext): JsonObject {
  const overrides = settingsOverrides(settings, context);
  if (context.nested) {
    const nested = isRecord(context.globalDocument.codePreview)
      ? { ...context.globalDocument.codePreview }
      : {};
    for (const key of CODE_PREVIEW_SETTING_KEYS) delete nested[key];
    return { ...context.globalDocument, codePreview: { ...nested, ...overrides } };
  }
  const document = { ...context.globalDocument };
  for (const key of CODE_PREVIEW_SETTING_KEYS) delete document[key];
  return { ...document, ...overrides };
}

function settingValuesEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left)
    ? Array.isArray(right) &&
        left.length === right.length &&
        left.every((entry, index) => entry === right[index])
    : left === right;
}

export function defaultSettingsSaveContext(defaults: CodePreviewSettings): SettingsSaveContext {
  return {
    baseline: cloneCodePreviewSettings(defaults),
    loaded: cloneCodePreviewSettings(defaults),
    globalOverrides: {},
    globalDocument: {},
    nested: false,
  };
}

const RecordSchema = Schema.Record(Schema.String, Schema.Json);
const isRecord = (value: unknown): value is JsonObject => Schema.is(RecordSchema)(value);

export function extractCodePreviewSettings(data: unknown): JsonObject {
  if (!isRecord(data)) return {};
  const nested = data.codePreview;
  if (isRecord(nested)) return nested;
  if (hasDirectCodePreviewSettings(data)) return data;
  const extracted: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("codePreview")) continue;
    const normalized = key.slice("codePreview".length);
    if (!normalized) continue;
    const first = normalized[0];
    if (first === undefined) continue;
    extracted[first.toLowerCase() + normalized.slice(1)] = value;
  }
  return extracted;
}

function hasDirectCodePreviewSettings(object: JsonObject): boolean {
  return CODE_PREVIEW_SETTING_KEYS.some((key) => key in object);
}
