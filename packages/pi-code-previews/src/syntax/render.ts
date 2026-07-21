import type { Theme } from "@earendil-works/pi-coding-agent";
import { bundledThemesInfo } from "shiki";
import { hashString } from "../cache/hash";
import { codePreviewPerformanceConfig } from "../config/env";
import { codePreviewSettings } from "../settings";
import { expandPreviewTabs } from "../shared/preview-tabs";
import { escapeControlChars } from "../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "./language";
import { requestSyntaxInitialize, requestSyntaxLanguage, syntaxProjection } from "./projection";

export type ShikiStatus = {
  initialized: boolean;
  cacheSize: number;
  cacheLimit: number;
  maxHighlightChars: number;
  loadedLanguages: number;
  pendingLanguages: number;
  statusVersion: number;
};

type RenderCacheEntry = {
  readonly source: string;
  readonly value: string[];
  readonly size: number;
};
const renderCache = new Map<string, RenderCacheEntry>();
let renderCacheChars = 0;
let renderGeneration = -1;

export function renderHighlightedText(
  text: string,
  lang: string | undefined,
  theme: Theme,
  invalidate?: () => void,
): string[] {
  const plain = () => plainHighlightedText(text, theme);
  if (!codePreviewSettings.syntaxHighlighting || !lang) return plain();
  return renderWithShiki(expandPreviewTabs(text), lang, invalidate) ?? plain();
}

export function renderWithShiki(
  code: string,
  lang: string | undefined,
  invalidate?: () => void,
): string[] | undefined {
  if (!lang || !codePreviewSettings.syntaxHighlighting || shouldSkipHighlight(code))
    return undefined;
  const snapshot = syntaxProjection();
  if (!snapshot?.highlighter || snapshot.theme !== codePreviewSettings.shikiTheme) {
    requestSyntaxInitialize(codePreviewSettings.shikiTheme, invalidate);
    return undefined;
  }
  if (renderGeneration !== snapshot.generation) {
    renderGeneration = snapshot.generation;
    renderCache.clear();
    renderCacheChars = 0;
  }
  const language = normalizePreviewLanguageAlias(lang);
  const key = `${snapshot.theme}\0${language}\0${code.length}\0${hashString(code)}`;
  const cached = renderCache.get(key);
  if (cached && isExactShikiCacheHit(cached, code)) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached.value;
  }
  if (!snapshot.loadedLanguages.includes(language)) requestSyntaxLanguage(language, invalidate);
  try {
    const tokens = snapshot.highlighter.codeToTokensBase(code, {
      lang: language as never,
      theme: snapshot.theme as never,
    });
    const rendered = tokens.map((line) =>
      normalizeContrast(line.map((token) => ansiFromToken(token)).join(""), snapshot.theme!),
    );
    const size = rendered.reduce((total, line) => total + line.length, 0);
    renderCache.set(key, { source: code, value: rendered, size });
    renderCacheChars += size;
    while (
      renderCache.size > codePreviewPerformanceConfig.cacheLimit ||
      renderCacheChars > codePreviewPerformanceConfig.cacheCharLimit
    ) {
      const oldest = renderCache.keys().next().value;
      if (oldest === undefined) break;
      const removed = renderCache.get(oldest);
      renderCache.delete(oldest);
      renderCacheChars -= removed?.size ?? 0;
    }
    return rendered;
  } catch {
    return undefined;
  }
}

const EMPTY_STATUS: ShikiStatus = {
  initialized: false,
  cacheSize: 0,
  cacheLimit: 0,
  maxHighlightChars: 0,
  loadedLanguages: 0,
  pendingLanguages: 0,
  statusVersion: 0,
};
export function getShikiStatus(): ShikiStatus {
  const snapshot = syntaxProjection();
  if (!snapshot) return EMPTY_STATUS;
  return {
    ...snapshot.status,
    cacheSize: renderGeneration === snapshot.generation ? renderCache.size : 0,
    cacheLimit: codePreviewPerformanceConfig.cacheLimit,
    maxHighlightChars: codePreviewPerformanceConfig.maxHighlightChars,
  };
}

export function isExactShikiCacheHit(
  cached: { readonly source: string } | undefined,
  source: string,
): boolean {
  return cached?.source === source;
}

export function shouldSkipHighlight(text: string): boolean {
  return text.length > codePreviewPerformanceConfig.maxHighlightChars;
}

const themeTypes = new Map(bundledThemesInfo.map((theme) => [theme.id, theme.type]));
export function isLightShikiTheme(theme: string): boolean {
  return themeTypes.get(theme) === "light";
}
function normalizeContrast(ansi: string, theme: string): string {
  if (isLightShikiTheme(theme)) return ansi;
  return ansi.replace(/\x1b\[([0-9;]*)m/g, (sequence, parameters: string) =>
    isLowContrastFg(parameters) ? "\x1b[38;2;139;148;158m" : sequence,
  );
}
function isLowContrastFg(parameters: string): boolean {
  if (
    parameters === "30" ||
    parameters === "90" ||
    parameters === "38;5;0" ||
    parameters === "38;5;8"
  )
    return true;
  if (!parameters.startsWith("38;2;")) return false;
  const [, , red, green, blue] = parameters.split(";").map(Number);
  if (
    red === undefined ||
    green === undefined ||
    blue === undefined ||
    ![red, green, blue].every(Number.isFinite)
  )
    return false;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 72;
}
function ansiFromToken(token: { content: string; color?: string; fontStyle?: number }): string {
  let open = token.color ? ansiFg(token.color) : "";
  let close = token.color ? "\x1b[39m" : "";
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 2) {
    open += "\x1b[1m";
    close = "\x1b[22m" + close;
  }
  if (fontStyle & 1) {
    open += "\x1b[3m";
    close = "\x1b[23m" + close;
  }
  if (fontStyle & 4) {
    open += "\x1b[4m";
    close = "\x1b[24m" + close;
  }
  return open + escapeControlChars(token.content) + close;
}
const ansiCache = new Map<string, string>();
function ansiFg(hex: string): string {
  const cached = ansiCache.get(hex);
  if (cached !== undefined) return cached;
  const value = Number.parseInt(hex.replace(/^#/, "").slice(0, 6), 16);
  const ansi = Number.isFinite(value)
    ? `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`
    : "";
  ansiCache.set(hex, ansi);
  return ansi;
}

export function plainHighlightedText(text: string, theme: Theme): string[] {
  return expandPreviewTabs(text)
    .split("\n")
    .map((line) => theme.fg("toolOutput", escapeControlChars(line)));
}
export function normalizeShikiLanguage(lang: string): string {
  return normalizePreviewLanguageAlias(lang);
}
