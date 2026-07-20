import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import { currentWorkingDirectory, environmentValue, warnBoundary } from "../boundary/environment";
import { nodeJoin } from "../boundary/node";
import { runSerializedPlatformEffect } from "../boundary/platform";
import { CODE_PREVIEW_SETTING_KEYS } from "./definitions";
import { defaultCodePreviewSettings } from "./defaults";
import { cloneCodePreviewSettings } from "./state";
import type { CodePreviewSettings } from "./types";
import { normalizeSettings } from "./values";

export type SettingsSaveContext = {
  baseline: CodePreviewSettings;
  loaded: CodePreviewSettings;
  globalOverrides: Record<string, unknown>;
  globalDocument: JsonObject;
  nested: boolean;
};

let settingsSaveContext = defaultSettingsSaveContext();
/** One coordination domain protects loaded state, save context, and persistence ordering. */
export const settingsBoundaryLock = Semaphore.makeUnsafe(1);
export const settingsCoordinationLock = Semaphore.makeUnsafe(1);

export function getSettingsPath(): string {
  return nodeJoin(getAgentDir(), "code-previews.json");
}

export type LoadSettingsOptions = {
  projectCwd?: string;
  projectTrusted?: boolean;
};

const loadSettingsFile = Effect.fn("CodePreviewSettings.loadFile")(function* (
  settingsPath: string,
  fallback: CodePreviewSettings,
) {
  const documents = yield* JsonDocumentStore;
  const document = yield* documents
    .readObject(settingsPath)
    .pipe(
      Effect.catch(() =>
        Effect.sync(() => warnBoundary(`Failed to load settings from ${settingsPath}.`)).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  if (!document) return undefined;
  const data = extractCodePreviewSettings(document);
  return { document, data, settings: normalizeSettings(data, fallback) };
});

export const loadSettingsFromDiskUnlockedEffect = Effect.fn("CodePreviewSettings.loadUnlocked")(
  function* (options: LoadSettingsOptions = {}) {
    const path = yield* Path.Path;
    const agentDir = getAgentDir();
    const home = environmentValue("HOME");
    const homeDir = home ?? path.dirname(path.dirname(agentDir));
    const settingsPath = path.join(agentDir, "code-previews.json");
    const legacyAgentDir = path.join(homeDir, ".pi", "agent");
    const projectCwd = options.projectCwd ?? currentWorkingDirectory();
    let loaded = false;
    let effective = cloneCodePreviewSettings(defaultCodePreviewSettings);
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
    settingsSaveContext = {
      baseline,
      loaded: cloneCodePreviewSettings(effective),
      globalOverrides: { ...globalSettings?.data },
      globalDocument: { ...globalSettings?.document },
      nested: isRecord(globalSettings?.document.codePreview),
    };
    return loaded ? effective : undefined;
  },
);

export const loadSettingsFromDiskEffect = (options: LoadSettingsOptions = {}) =>
  settingsCoordinationLock.withPermits(1)(loadSettingsFromDiskUnlockedEffect(options));

export function loadSettingsFromDisk(
  options: LoadSettingsOptions = {},
): Promise<CodePreviewSettings | undefined> {
  return runSerializedPlatformEffect(settingsBoundaryLock, loadSettingsFromDiskEffect(options));
}

export function getSettingsSaveContext(): SettingsSaveContext {
  return {
    baseline: cloneCodePreviewSettings(settingsSaveContext.baseline),
    loaded: cloneCodePreviewSettings(settingsSaveContext.loaded),
    globalOverrides: { ...settingsSaveContext.globalOverrides },
    globalDocument: { ...settingsSaveContext.globalDocument },
    nested: settingsSaveContext.nested,
  };
}

export const saveSettingsToDiskEffect = Effect.fn("CodePreviewSettings.save")(function* (
  settings: CodePreviewSettings,
  context?: SettingsSaveContext,
) {
  yield* settingsCoordinationLock.withPermits(1)(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const documents = yield* JsonDocumentStore;
      const settingsPath = path.join(getAgentDir(), "code-previews.json");
      const currentContext = context ?? getSettingsSaveContext();
      yield* documents.updateObject(settingsPath, (latest) =>
        settingsDocument(settings, {
          ...currentContext,
          globalDocument: latest,
          nested: isRecord(latest.codePreview),
        }),
      );
    }),
  );
});

export function saveSettingsToDisk(
  settings: CodePreviewSettings,
  context?: SettingsSaveContext,
): Promise<void> {
  return runSerializedPlatformEffect(
    settingsBoundaryLock,
    saveSettingsToDiskEffect(settings, context),
  );
}

export const waitForSettingsSavesEffect = Effect.void;

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

function defaultSettingsSaveContext(): SettingsSaveContext {
  return {
    baseline: cloneCodePreviewSettings(defaultCodePreviewSettings),
    loaded: cloneCodePreviewSettings(defaultCodePreviewSettings),
    globalOverrides: {},
    globalDocument: {},
    nested: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function extractCodePreviewSettings(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const nested = data.codePreview;
  if (isRecord(nested)) return nested;
  if (hasDirectCodePreviewSettings(data)) return data;
  const extracted: Record<string, unknown> = {};
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

function hasDirectCodePreviewSettings(object: Record<string, unknown>): boolean {
  return CODE_PREVIEW_SETTING_KEYS.some((key) => key in object);
}
