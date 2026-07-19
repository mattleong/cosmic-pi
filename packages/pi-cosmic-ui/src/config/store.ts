import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  FOOTER_DENSITIES,
  MEDIA_PLACEMENTS,
  type CosmicUiConfigFile,
  type FooterDensity,
  type MediaPlacement,
  type ResolvedCosmicUiConfig,
} from "./schema.ts";

export const CONFIG_BASENAME = "pi-cosmic-ui.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configPaths(cwd: string, agentDir = getAgentDir()) {
  return {
    project: join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_BASENAME),
    global: join(agentDir, "extensions", CONFIG_BASENAME),
  };
}

function readExistingConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`Cosmic UI config must contain a JSON object: ${path}`);
  return value;
}

export function readRawConfig(path: string): Record<string, unknown> {
  try {
    return readExistingConfig(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-cosmic-ui] Failed to read ${path}: ${message}`);
    return {};
  }
}

export function readConfig(path: string): CosmicUiConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readRawConfig(path);
  if (!isRecord(raw.footer)) return {};
  const footer: NonNullable<CosmicUiConfigFile["footer"]> = {};
  if (typeof raw.footer.enabled === "boolean") footer.enabled = raw.footer.enabled;
  if (
    typeof raw.footer.density === "string" &&
    (FOOTER_DENSITIES as readonly string[]).includes(raw.footer.density)
  )
    footer.density = raw.footer.density as FooterDensity;
  if (Array.isArray(raw.footer.order))
    footer.order = raw.footer.order.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(raw.footer.hidden))
    footer.hidden = raw.footer.hidden.filter((entry): entry is string => typeof entry === "string");
  if (
    typeof raw.footer.mediaPlacement === "string" &&
    (MEDIA_PLACEMENTS as readonly string[]).includes(raw.footer.mediaPlacement)
  )
    footer.mediaPlacement = raw.footer.mediaPlacement as MediaPlacement;
  return { footer };
}

export function writeRawConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveConfig(cwd: string, agentDir = getAgentDir()): ResolvedCosmicUiConfig {
  const paths = configPaths(cwd, agentDir);
  const project = readConfig(paths.project) ?? {};
  const global = readConfig(paths.global) ?? {};
  const footer = { ...DEFAULT_CONFIG.footer, ...global.footer, ...project.footer };
  return {
    configPath: existsSync(paths.project) ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    footer: {
      enabled: footer.enabled ?? true,
      density: footer.density ?? "auto",
      order: [...(footer.order ?? [])],
      hidden: [...(footer.hidden ?? [])],
      mediaPlacement: footer.mediaPlacement ?? "inline-right",
    },
  };
}

export function updateFooterConfig(
  cwd: string,
  config: ResolvedCosmicUiConfig,
  patch: Partial<ResolvedCosmicUiConfig["footer"]>,
  agentDir = getAgentDir(),
): ResolvedCosmicUiConfig {
  const raw = readExistingConfig(config.configPath);
  const currentFooter = isRecord(raw.footer) ? raw.footer : {};
  writeRawConfig(config.configPath, { ...raw, footer: { ...currentFooter, ...patch } });
  return resolveConfig(cwd, agentDir);
}
