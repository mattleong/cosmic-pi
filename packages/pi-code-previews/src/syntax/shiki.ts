import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { bundledThemesInfo } from "shiki";
import { forkShikiEffect, runShikiEffect } from "../boundary/platform";
import { ShikiAdapter, type ShikiHighlighter } from "../boundary/shiki";
import { positiveEnvInteger } from "../config/env";
import { hashString } from "../cache/hash";
import { codePreviewSettings } from "../settings/index";
import { expandPreviewTabs } from "../shared/preview-tabs";
import { escapeControlChars } from "../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "./language";

let shikiHighlighter: ShikiHighlighter | undefined;
let shikiInitVersion = 0;
let shikiHighlighterGeneration = 0;
type InitializationFlight = {
  readonly theme: string;
  readonly version: number;
  readonly done: Deferred.Deferred<void>;
};
const initializationFlight = MutableRef.make<InitializationFlight | undefined>(undefined);
let shikiStatusVersion = 0;
let renderCacheChars = 0;
const loadedShikiLanguages = new Set<string>();
const pendingShikiLanguages = new Set<string>();
const renderCache = new Map<string, { value: string[]; size: number }>();
const languageLoadCallbacks = new Map<string, Set<() => void>>();
const highlighterReadyCallbacks = new Set<() => void>();
const shikiThemeTypes = new Map(bundledThemesInfo.map((theme) => [theme.id, theme.type]));

const MAX_HIGHLIGHT_CHARS = positiveEnvInteger("CODE_PREVIEW_MAX_HIGHLIGHT_CHARS", 80000);
const CACHE_LIMIT = positiveEnvInteger("CODE_PREVIEW_CACHE_LIMIT", 192);
const CACHE_CHAR_LIMIT = positiveEnvInteger("CODE_PREVIEW_CACHE_CHAR_LIMIT", 4_000_000);

const PRELOADED_SHIKI_LANGUAGES = [
  "bash",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "diff",
  "yaml",
] as const;

export const initializeShikiEffect = Effect.fn("CodePreviewShiki.initialize")(function* (
  theme: string,
) {
  if (!codePreviewSettings.syntaxHighlighting) return;
  const current = MutableRef.get(initializationFlight);
  if (current?.theme === theme) return yield* Deferred.await(current.done);
  const version = ++shikiInitVersion;
  const done = yield* Deferred.make<void>();
  const flight = { theme, version, done } satisfies InitializationFlight;
  MutableRef.set(initializationFlight, flight);
  const adapter = yield* ShikiAdapter;
  yield* adapter.create(theme, PRELOADED_SHIKI_LANGUAGES).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.sync(() => {
          if (version !== shikiInitVersion) return;
          shikiHighlighter?.dispose();
          shikiHighlighter = undefined;
          shikiHighlighterGeneration++;
          bumpShikiStatusVersion();
          resetShikiLanguageState();
          highlighterReadyCallbacks.clear();
        }).pipe(
          Effect.andThen(
            Effect.logWarning("Shiki failed to initialize; code previews will use plain text."),
          ),
        ),
      onSuccess: (nextHighlighter) =>
        Effect.sync(() => {
          if (version !== shikiInitVersion) {
            nextHighlighter.dispose();
            return;
          }
          const previousHighlighter = shikiHighlighter;
          shikiHighlighter = nextHighlighter;
          shikiHighlighterGeneration++;
          bumpShikiStatusVersion();
          previousHighlighter?.dispose();
          resetShikiLanguageState();
          for (const lang of PRELOADED_SHIKI_LANGUAGES) loadedShikiLanguages.add(lang);
          notifyHighlighterReady();
        }),
    }),
    Effect.ensuring(
      Effect.sync(() => {
        if (MutableRef.get(initializationFlight) === flight)
          MutableRef.set(initializationFlight, undefined);
      }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
    ),
  );
});

export function initializeShiki(theme: string): Promise<void> {
  return runShikiEffect(initializeShikiEffect(theme));
}

export const disposeShikiEffect = Effect.sync(() => {
  ++shikiInitVersion;
  MutableRef.set(initializationFlight, undefined);
  shikiHighlighter?.dispose();
  shikiHighlighter = undefined;
  shikiHighlighterGeneration++;
  resetShikiLanguageState();
  highlighterReadyCallbacks.clear();
  bumpShikiStatusVersion();
});

export function renderHighlightedText(
  text: string,
  lang: string | undefined,
  theme: Theme,
  invalidate?: () => void,
): string[] {
  const normalized = expandPreviewTabs(text);
  const plain = () =>
    normalized.split("\n").map((line) => theme.fg("toolOutput", escapeControlChars(line)));
  if (!codePreviewSettings.syntaxHighlighting || !lang) return plain();
  return renderWithShiki(normalized, lang, invalidate) ?? plain();
}

export function renderWithShiki(
  code: string,
  lang: string | undefined,
  invalidate?: () => void,
): string[] | undefined {
  if (!codePreviewSettings.syntaxHighlighting || !lang || shouldSkipHighlight(code))
    return undefined;
  if (!shikiHighlighter) {
    requestHighlighterInit(codePreviewSettings.shikiTheme, invalidate);
    return undefined;
  }
  const shikiLang = normalizeShikiLanguage(lang);
  const cacheKey = `${codePreviewSettings.shikiTheme}\0${shikiLang}\0${code.length}\0${hashString(code)}`;
  const cached = renderCache.get(cacheKey);
  if (cached) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached.value;
  }
  try {
    if (!loadedShikiLanguages.has(shikiLang)) requestLanguageLoad(shikiLang, invalidate);
    const tokens = shikiHighlighter.codeToTokensBase(code, {
      lang: shikiLang as never,
      theme: codePreviewSettings.shikiTheme as never,
    });
    const rendered = tokens.map((line) =>
      normalizeShikiContrast(line.map((token) => ansiFromToken(token)).join("")),
    );
    cacheRendered(cacheKey, rendered);
    return rendered;
  } catch {
    return undefined;
  }
}

export function shouldSkipHighlight(text: string): boolean {
  return text.length > MAX_HIGHLIGHT_CHARS;
}

export function getShikiStatus(): {
  initialized: boolean;
  cacheSize: number;
  cacheLimit: number;
  maxHighlightChars: number;
  loadedLanguages: number;
  pendingLanguages: number;
  statusVersion: number;
} {
  return {
    initialized: Boolean(shikiHighlighter),
    cacheSize: renderCache.size,
    cacheLimit: CACHE_LIMIT,
    maxHighlightChars: MAX_HIGHLIGHT_CHARS,
    loadedLanguages: loadedShikiLanguages.size,
    pendingLanguages: pendingShikiLanguages.size,
    statusVersion: shikiStatusVersion,
  };
}

function cacheRendered(key: string, value: string[]): void {
  const size = renderedCharSize(value);
  renderCache.set(key, { value, size });
  renderCacheChars += size;
  while (renderCache.size > CACHE_LIMIT || renderCacheChars > CACHE_CHAR_LIMIT) {
    const first = renderCache.keys().next().value;
    if (first === undefined) break;
    deleteCachedRender(first);
  }
}

function deleteCachedRender(key: string): void {
  const cached = renderCache.get(key);
  renderCache.delete(key);
  renderCacheChars -= cached?.size ?? 0;
}

function clearRenderCache(): void {
  renderCache.clear();
  renderCacheChars = 0;
}

function resetShikiLanguageState(): void {
  clearRenderCache();
  loadedShikiLanguages.clear();
  pendingShikiLanguages.clear();
  languageLoadCallbacks.clear();
}

function bumpShikiStatusVersion(): void {
  shikiStatusVersion++;
}

function renderedCharSize(value: string[]): number {
  let total = 0;
  for (const line of value) total += line.length;
  return total;
}

function requestHighlighterInit(theme: string, invalidate: (() => void) | undefined): void {
  if (invalidate) highlighterReadyCallbacks.add(invalidate);
  if (MutableRef.get(initializationFlight)?.theme === theme) return;
  forkShikiEffect(initializeShikiEffect(theme));
}

function notifyHighlighterReady(): void {
  const callbacks = [...highlighterReadyCallbacks];
  highlighterReadyCallbacks.clear();
  callbacks.forEach((callback) => callback());
}

function requestLanguageLoad(shikiLang: string, invalidate: (() => void) | undefined): void {
  if (invalidate) {
    const callbacks = languageLoadCallbacks.get(shikiLang) ?? new Set<() => void>();
    callbacks.add(invalidate);
    languageLoadCallbacks.set(shikiLang, callbacks);
  }
  if (pendingShikiLanguages.has(shikiLang)) return;
  const highlighter = shikiHighlighter;
  if (!highlighter) return;
  const generation = shikiHighlighterGeneration;
  pendingShikiLanguages.add(shikiLang);
  forkShikiEffect(
    ShikiAdapter.use((adapter) => adapter.loadLanguage(highlighter, shikiLang)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (generation !== shikiHighlighterGeneration) return;
          loadedShikiLanguages.add(shikiLang);
          bumpShikiStatusVersion();
          const callbacks = languageLoadCallbacks.get(shikiLang);
          languageLoadCallbacks.delete(shikiLang);
          callbacks?.forEach((callback) => callback());
        }),
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          if (generation === shikiHighlighterGeneration) {
            bumpShikiStatusVersion();
            languageLoadCallbacks.delete(shikiLang);
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (generation === shikiHighlighterGeneration) pendingShikiLanguages.delete(shikiLang);
        }),
      ),
    ),
  );
}

export function normalizeShikiLanguage(lang: string): string {
  return normalizePreviewLanguageAlias(lang);
}

export function isLightShikiTheme(theme: string): boolean {
  return shikiThemeTypes.get(theme) === "light";
}

function normalizeShikiContrast(ansi: string): string {
  if (isLightShikiTheme(codePreviewSettings.shikiTheme)) return ansi;
  return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) =>
    isLowContrastFg(params) ? "\x1b[38;2;139;148;158m" : seq,
  );
}

function isLowContrastFg(params: string): boolean {
  if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return true;
  if (!params.startsWith("38;2;")) return false;
  const [, , r, g, b] = params.split(";").map(Number);
  if (r === undefined || g === undefined || b === undefined || ![r, g, b].every(Number.isFinite))
    return false;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 72;
}

function ansiFromToken(token: { content: string; color?: string; fontStyle?: number }): string {
  let open = token.color ? ansiFg(token.color) : "";
  let close = token.color ? "\x1b[39m" : "";
  // TextMate fontStyle bit flags: italic=1, bold=2, underline=4.
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

const ansiFgCache = new Map<string, string>();

function ansiFg(hex: string): string {
  const cached = ansiFgCache.get(hex);
  if (cached !== undefined) return cached;
  const clean = hex.replace(/^#/, "").slice(0, 6);
  const n = Number.parseInt(clean, 16);
  const ansi = Number.isFinite(n)
    ? `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
    : "";
  ansiFgCache.set(hex, ansi);
  return ansi;
}
