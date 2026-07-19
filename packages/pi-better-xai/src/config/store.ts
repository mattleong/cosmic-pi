import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_BASENAME, logPrefix } from "../identity.ts";
import { isRecord } from "../utils.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FOOTER_MODES,
  type ConfigFile,
  type FooterMode,
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
  const projectExists = existsSync(paths.project);
  const globalExists = existsSync(paths.global);
  const project = projectExists ? readConfig(paths.project) : undefined;
  const global = globalExists ? readConfig(paths.global) : undefined;
  const usage = {
    ...DEFAULT_USAGE_CONFIG,
    ...global?.usage,
    ...project?.usage,
  };
  const footer = {
    ...DEFAULT_FOOTER_CONFIG,
    ...global?.footer,
    ...project?.footer,
  };
  return {
    configPath: projectExists ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists: projectExists,
    globalConfigExists: globalExists,
    usage: {
      enabled: usage.enabled,
      refreshIntervalMs: Math.max(5_000, usage.refreshIntervalMs),
      showOnlyOnSubscriptionModels: usage.showOnlyOnSubscriptionModels,
      showResetTimes: usage.showResetTimes,
    },
    footer: {
      mode: footer.mode,
    },
  };
}
