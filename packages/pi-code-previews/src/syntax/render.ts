import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { bundledThemesInfo } from "shiki/themes";
import type { ShikiHighlighter } from "../boundary/shiki";
import { codePreviewPerformanceConfig, codePreviewSettings } from "../config/state";
import { expandPreviewTabs, hashString } from "../shared/helpers";
import {
  escapeControlChars,
  escapeLineControlChars,
  replaceSgrSequences,
} from "../shared/terminal-text";
import { isShikiLanguage, normalizePreviewLanguageAlias } from "./language";
import {
  requestSyntaxInitialize,
  requestSyntaxLanguage,
  syntaxProjection,
  type CodePreviewSyntaxSnapshot,
  type ShikiStatus,
} from "./projection";

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

export function discardShikiRenderCache(highlighter: ShikiHighlighter): void {
  if (renderCacheOwner?.highlighter !== highlighter) return;
  clearRenderCache();
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

type ShikiTheme = typeof codePreviewSettings.shikiTheme;

function readyHighlighter(
  theme: ShikiTheme,
  invalidate: (() => void) | undefined,
):
  | { readonly snapshot: CodePreviewSyntaxSnapshot; readonly highlighter: ShikiHighlighter }
  | undefined {
  const snapshot = syntaxProjection();
  if (snapshot?.highlighter && snapshot.theme === theme)
    return { snapshot, highlighter: snapshot.highlighter };
  if (!snapshot?.failedThemes.includes(theme)) requestSyntaxInitialize(theme, invalidate);
  return undefined;
}

function cachedRender(key: string, code: string): string[] | undefined {
  const cached = renderCache.get(key);
  if (!cached || cached.source !== code) return undefined;
  renderCache.delete(key);
  renderCache.set(key, cached);
  return cached.value;
}

function evictRenderCache(): void {
  for (const [oldest, entry] of renderCache) {
    if (
      renderCache.size <= codePreviewPerformanceConfig.cacheLimit &&
      renderCacheChars <= codePreviewPerformanceConfig.cacheCharLimit
    )
      break;
    renderCache.delete(oldest);
    renderCacheChars -= entry.size;
  }
}

function rememberRender(key: string, code: string, rendered: string[]): void {
  const size = Arr.reduce(rendered, 0, (total, line) => total + line.length);
  renderCache.set(key, { source: code, value: rendered, size });
  renderCacheChars += size;
  evictRenderCache();
}

export function renderWithShiki(
  code: string,
  lang: string | undefined,
  invalidate?: () => void,
): string[] | undefined {
  if (!lang || !codePreviewSettings.syntaxHighlighting || shouldSkipHighlight(code))
    return undefined;
  const theme = codePreviewSettings.shikiTheme;
  const ready = readyHighlighter(theme, invalidate);
  if (!ready) return undefined;
  const { snapshot, highlighter } = ready;
  const language = normalizePreviewLanguageAlias(lang);
  if (snapshot.failedLanguages.includes(language)) return undefined;
  claimRenderCache(highlighter, theme);
  const key = `${theme}\0${language}\0${code.length}\0${hashString(code)}`;
  const cached = cachedRender(key, code);
  if (cached) return cached;
  if (!snapshot.loadedLanguages.includes(language)) requestSyntaxLanguage(language, invalidate);
  if (!isShikiLanguage(language)) return undefined;
  try {
    const tokens = highlighter.codeToTokensBase(code, { lang: language, theme });
    const rendered = Arr.map(tokens, (line) =>
      normalizeContrast(
        Arr.join(
          Arr.map(line, (token) => ansiFromToken(token)),
          "",
        ),
        theme,
      ),
    );
    rememberRender(key, code, rendered);
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

const themeTypes = new Map(Arr.map(bundledThemesInfo, (theme) => [theme.id, theme.type]));
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
  if (!Fn.pipe(parameters, Str.startsWith("38;2;"))) return false;
  const [, , red = Number.NaN, green = Number.NaN, blue = Number.NaN] = Arr.map(
    Str.split(parameters, ";"),
    Number,
  );
  return (
    Arr.every([red, green, blue], Number.isFinite) &&
    0.2126 * red + 0.7152 * green + 0.0722 * blue < 72
  );
}
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
  const value = Number.parseInt(Fn.pipe(hex, Str.replace(/^#/, ""), Str.slice(0, 6)), 16);
  return Number.isFinite(value)
    ? `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`
    : "";
}

function plainHighlightedText(text: string, theme: Theme): string[] {
  return Arr.map(Str.split(expandPreviewTabs(text), "\n"), (line) =>
    theme.fg("toolOutput", escapeLineControlChars(line)),
  );
}
