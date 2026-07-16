import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_BASENAME, logPrefix } from "../identity.ts";
import { isRecord } from "../utils.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FOOTER_MODES,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  PET_PLACEMENTS,
  PET_STATES,
  type ConfigFile,
  type FooterMode,
  type ImageOutputFormat,
  type ImageSaveMode,
  type PetPlacement,
  type PetState,
  type ResolvedConfig,
} from "./schema.ts";

export function configPaths(cwd: string, agentDir = getAgentDir()) {
  return {
    project: join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_BASENAME),
    global: join(agentDir, "extensions", CONFIG_BASENAME),
  };
}

export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to read ${path}: ${message}`);
    return {};
  }
}

export function readConfig(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = readRawConfig(path);
  const config: ConfigFile = {};
  if (typeof parsed.persistState === "boolean") config.persistState = parsed.persistState;
  if (typeof parsed.active === "boolean") config.active = parsed.active;
  if (typeof parsed.desiredActive === "boolean") config.desiredActive = parsed.desiredActive;
  if (isRecord(parsed.usage)) {
    config.usage = {};
    if (typeof parsed.usage.enabled === "boolean") config.usage.enabled = parsed.usage.enabled;
    if (typeof parsed.usage.refreshIntervalMs === "number")
      config.usage.refreshIntervalMs = parsed.usage.refreshIntervalMs;
    if (typeof parsed.usage.showOnlyOnSubscriptionModels === "boolean")
      config.usage.showOnlyOnSubscriptionModels = parsed.usage.showOnlyOnSubscriptionModels;
    if (typeof parsed.usage.showResetTimes === "boolean")
      config.usage.showResetTimes = parsed.usage.showResetTimes;
  }
  if (
    isRecord(parsed.footer) &&
    typeof parsed.footer.mode === "string" &&
    (FOOTER_MODES as readonly string[]).includes(parsed.footer.mode)
  ) {
    config.footer = { mode: parsed.footer.mode as FooterMode };
  }
  if (isRecord(parsed.image)) {
    config.image = {};
    if (typeof parsed.image.enabled === "boolean") config.image.enabled = parsed.image.enabled;
    if (typeof parsed.image.defaultModel === "string" && parsed.image.defaultModel.trim())
      config.image.defaultModel = parsed.image.defaultModel.trim();
    if (
      typeof parsed.image.defaultSave === "string" &&
      (IMAGE_SAVE_MODES as readonly string[]).includes(parsed.image.defaultSave)
    )
      config.image.defaultSave = parsed.image.defaultSave as ImageSaveMode;
    if (
      typeof parsed.image.outputFormat === "string" &&
      (IMAGE_OUTPUT_FORMATS as readonly string[]).includes(parsed.image.outputFormat)
    )
      config.image.outputFormat = parsed.image.outputFormat as ImageOutputFormat;
    if (typeof parsed.image.timeoutMs === "number") config.image.timeoutMs = parsed.image.timeoutMs;
  }
  if (isRecord(parsed.pets)) {
    config.pets = {};
    if (typeof parsed.pets.enabled === "boolean") config.pets.enabled = parsed.pets.enabled;
    if (typeof parsed.pets.slug === "string") config.pets.slug = parsed.pets.slug.trim();
    if (
      typeof parsed.pets.placement === "string" &&
      (PET_PLACEMENTS as readonly string[]).includes(parsed.pets.placement)
    )
      config.pets.placement = parsed.pets.placement as PetPlacement;
    if (
      typeof parsed.pets.state === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.state)
    )
      config.pets.state = parsed.pets.state as PetState;
    if (
      typeof parsed.pets.thinkingState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.thinkingState)
    )
      config.pets.thinkingState = parsed.pets.thinkingState as PetState;
    if (
      typeof parsed.pets.toolState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.toolState)
    )
      config.pets.toolState = parsed.pets.toolState as PetState;
    if (
      typeof parsed.pets.failedToolState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.failedToolState)
    )
      config.pets.failedToolState = parsed.pets.failedToolState as PetState;
    if (typeof parsed.pets.idleEmotes === "boolean")
      config.pets.idleEmotes = parsed.pets.idleEmotes;
    if (typeof parsed.pets.idleEmoteIntervalMs === "number")
      config.pets.idleEmoteIntervalMs = parsed.pets.idleEmoteIntervalMs;
    if (typeof parsed.pets.sizeCells === "number") config.pets.sizeCells = parsed.pets.sizeCells;
  }
  return config;
}

export function writeConfig(path: string, config: ConfigFile | Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to write ${path}: ${message}`);
  }
}

function ensureConfigFile(projectConfigPath: string, globalConfigPath: string): void {
  if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) return;
  writeConfig(globalConfigPath, DEFAULT_CONFIG);
}

export function resolveConfig(cwd: string): ResolvedConfig {
  const paths = configPaths(cwd);
  ensureConfigFile(paths.project, paths.global);

  const projectConfigExists = existsSync(paths.project);
  const globalConfigExists = existsSync(paths.global);
  const globalConfig = readConfig(paths.global) ?? {};
  const projectConfig = readConfig(paths.project) ?? {};
  const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
  const selectedPath = projectConfigExists ? paths.project : paths.global;
  const desiredActive = merged.desiredActive ?? merged.active ?? false;

  return {
    configPath: selectedPath,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists,
    globalConfigExists,
    persistState: merged.persistState ?? true,
    active: merged.active ?? desiredActive,
    desiredActive,
    usage: {
      ...DEFAULT_USAGE_CONFIG,
      ...globalConfig.usage,
      ...projectConfig.usage,
      refreshIntervalMs: Math.max(
        15_000,
        Math.min(
          10 * 60_000,
          projectConfig.usage?.refreshIntervalMs ??
            globalConfig.usage?.refreshIntervalMs ??
            DEFAULT_USAGE_CONFIG.refreshIntervalMs,
        ),
      ),
    },
    footer: {
      ...DEFAULT_FOOTER_CONFIG,
      ...globalConfig.footer,
      ...projectConfig.footer,
    },
    image: {
      ...DEFAULT_IMAGE_CONFIG,
      ...globalConfig.image,
      ...projectConfig.image,
      timeoutMs: Math.max(
        30_000,
        Math.min(
          5 * 60_000,
          projectConfig.image?.timeoutMs ??
            globalConfig.image?.timeoutMs ??
            DEFAULT_IMAGE_CONFIG.timeoutMs,
        ),
      ),
    },
    pets: {
      ...DEFAULT_PET_CONFIG,
      ...globalConfig.pets,
      ...projectConfig.pets,
      idleEmoteIntervalMs: Math.max(
        5_000,
        Math.min(
          5 * 60_000,
          projectConfig.pets?.idleEmoteIntervalMs ??
            globalConfig.pets?.idleEmoteIntervalMs ??
            DEFAULT_PET_CONFIG.idleEmoteIntervalMs,
        ),
      ),
      sizeCells: Math.max(
        4,
        Math.min(
          16,
          projectConfig.pets?.sizeCells ??
            globalConfig.pets?.sizeCells ??
            DEFAULT_PET_CONFIG.sizeCells,
        ),
      ),
    },
  };
}
