import type { Theme } from "@earendil-works/pi-coding-agent";
import { bundledThemesInfo } from "shiki";
import type { ShikiHighlighter } from "../boundary/shiki";
import { hashString } from "../shared/helpers";
import { codePreviewPerformanceConfig } from "../config/state";
import { codePreviewSettings } from "../config/state";
import { expandPreviewTabs } from "../shared/helpers";
import { escapeControlChars, replaceSgrSequences } from "../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "./language";
import {
  requestSyntaxInitialize,
  requestSyntaxLanguage,
  syntaxProjection,
  type ShikiStatus,
} from "./projection";

export type { ShikiStatus } from "./projection";

type RenderCacheEntry = {
  readonly source: string;
  readonly value: string[];
  readonly size: number;
};
type RenderCacheOwner = {
  readonly highlighter: ShikiHighlighter;
  readonly theme: string;
};

const renderCache = new Map<string, RenderCacheEntry>();
const ansiCache = new Map<string, string>();
let renderCacheChars = 0;
let renderCacheOwner: RenderCacheOwner | undefined;

function clearRenderCache(): void {
  renderCache.clear();
  renderCacheChars = 0;
}

function claimRenderCache(highlighter: ShikiHighlighter, theme: string): void {
  if (renderCacheOwner?.highlighter === highlighter && renderCacheOwner.theme === theme) return;
  clearRenderCache();
  renderCacheOwner = { highlighter, theme };
}

/** Discards cache entries only when this highlighter still owns them. */
export function discardShikiRenderCache(highlighter: ShikiHighlighter): void {
  if (renderCacheOwner?.highlighter !== highlighter) return;
  clearRenderCache();
  ansiCache.clear();
  renderCacheOwner = undefined;
}

export function renderHighlightedText(
  text: string,
  lang: string | undefined,
  theme: Theme,
  invalidate?: () => void,
): string[] {
  return (
    renderWithShiki(expandPreviewTabs(text), lang, invalidate) ?? plainHighlightedText(text, theme)
  );
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
  claimRenderCache(snapshot.highlighter, snapshot.theme);
  const language = normalizePreviewLanguageAlias(lang);
  const key = `${snapshot.theme}\0${language}\0${code.length}\0${hashString(code)}`;
  const cached = renderCache.get(key);
  if (cached && cached.source === code) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached.value;
  }
  if (!snapshot.loadedLanguages.includes(language)) requestSyntaxLanguage(language, invalidate);
  try {
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
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
    cacheSize:
      renderCacheOwner?.highlighter === snapshot.highlighter &&
      renderCacheOwner?.theme === snapshot.theme
        ? renderCache.size
        : 0,
    cacheLimit: codePreviewPerformanceConfig.cacheLimit,
    maxHighlightChars: codePreviewPerformanceConfig.maxHighlightChars,
  };
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
  return replaceSgrSequences(ansi, (sequence, parameters) =>
    isLowContrastFg(parameters) ? "\x1b[38;2;139;148;158m" : sequence,
  );
}
const LOW_CONTRAST_BASIC_FG = new Set(["30", "90", "38;5;0", "38;5;8"]);
function isLowContrastFg(parameters: string): boolean {
  if (LOW_CONTRAST_BASIC_FG.has(parameters)) return true;
  if (!parameters.startsWith("38;2;")) return false;
  const [, , red = Number.NaN, green = Number.NaN, blue = Number.NaN] = parameters
    .split(";")
    .map(Number);
  return (
    [red, green, blue].every(Number.isFinite) && 0.2126 * red + 0.7152 * green + 0.0722 * blue < 72
  );
}
/** Shiki font-style flags in open order (bold, italic, underline); closes nest in reverse. */
const FONT_STYLES = [
  [2, "\x1b[1m", "\x1b[22m"],
  [1, "\x1b[3m", "\x1b[23m"],
  [4, "\x1b[4m", "\x1b[24m"],
] as const;
function ansiFromToken(token: { content: string; color?: string; fontStyle?: number }): string {
  let open = token.color ? ansiFg(token.color) : "";
  let close = token.color ? "\x1b[39m" : "";
  const fontStyle = token.fontStyle ?? 0;
  for (const [flag, styleOpen, styleClose] of FONT_STYLES) {
    if (!(fontStyle & flag)) continue;
    open += styleOpen;
    close = styleClose + close;
  }
  return open + escapeControlChars(token.content) + close;
}
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
