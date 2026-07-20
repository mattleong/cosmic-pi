import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bundledThemesInfo } from "shiki";
import { ShikiAdapter, type ShikiHighlighter } from "../boundary/shiki";
import { hashString } from "../cache/hash";
import { codePreviewPerformanceConfig } from "../config/env";
import { forkCodePreviewSessionEffect } from "../session-capability";
import { codePreviewSettings } from "../settings";
import { expandPreviewTabs } from "../shared/preview-tabs";
import { escapeControlChars } from "../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "./language";

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

type InitializationFlight = {
  readonly theme: string;
  readonly version: number;
  readonly done: Deferred.Deferred<void>;
};
type RenderCacheEntry = {
  readonly source: string;
  readonly value: string[];
  readonly size: number;
};
export type ShikiStatus = {
  initialized: boolean;
  cacheSize: number;
  cacheLimit: number;
  maxHighlightChars: number;
  loadedLanguages: number;
  pendingLanguages: number;
  statusVersion: number;
};

export interface CodePreviewSyntaxServiceShape {
  readonly initialize: (theme: string) => Effect.Effect<void>;
  readonly render: (code: string, lang: string, invalidate?: () => void) => string[] | undefined;
  readonly status: () => ShikiStatus;
  readonly dispose: Effect.Effect<void>;
}

let activeSyntaxProjection: CodePreviewSyntaxServiceShape | undefined;
export function syntaxServiceProjection(): CodePreviewSyntaxServiceShape | undefined {
  return activeSyntaxProjection;
}

export class CodePreviewSyntaxService extends Context.Service<
  CodePreviewSyntaxService,
  CodePreviewSyntaxServiceShape
>()("pi-code-previews/syntax/service/CodePreviewSyntaxService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const adapter = yield* ShikiAdapter;
      let highlighter: ShikiHighlighter | undefined;
      let initVersion = 0;
      let generation = 0;
      let initialization: InitializationFlight | undefined;
      let statusVersion = 0;
      let renderCacheChars = 0;
      const loadedLanguages = new Set<string>();
      const pendingLanguages = new Set<string>();
      const renderCache = new Map<string, RenderCacheEntry>();
      const languageCallbacks = new Map<string, Set<() => void>>();
      const readyCallbacks = new Set<() => void>();

      const clearLanguageState = () => {
        renderCache.clear();
        renderCacheChars = 0;
        loadedLanguages.clear();
        pendingLanguages.clear();
        languageCallbacks.clear();
      };
      const dispose = Effect.sync(() => {
        ++initVersion;
        initialization = undefined;
        highlighter?.dispose();
        highlighter = undefined;
        generation++;
        clearLanguageState();
        readyCallbacks.clear();
        statusVersion++;
      });

      let service: CodePreviewSyntaxServiceShape;
      const initialize = Effect.fn("CodePreviewShiki.initialize")(function* (theme: string) {
        if (!codePreviewSettings.syntaxHighlighting) return;
        if (initialization?.theme === theme) return yield* Deferred.await(initialization.done);
        const version = ++initVersion;
        const done = yield* Deferred.make<void>();
        const flight = { theme, version, done } satisfies InitializationFlight;
        initialization = flight;
        yield* adapter.create(theme, PRELOADED_SHIKI_LANGUAGES).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.sync(() => {
                if (version !== initVersion) return;
                highlighter?.dispose();
                highlighter = undefined;
                generation++;
                statusVersion++;
                clearLanguageState();
                readyCallbacks.clear();
              }).pipe(
                Effect.andThen(
                  Effect.logWarning(
                    "Shiki failed to initialize; code previews will use plain text.",
                  ),
                ),
              ),
            onSuccess: (next) =>
              Effect.sync(() => {
                if (version !== initVersion) {
                  next.dispose();
                  return;
                }
                const previous = highlighter;
                highlighter = next;
                generation++;
                statusVersion++;
                previous?.dispose();
                clearLanguageState();
                for (const language of PRELOADED_SHIKI_LANGUAGES) loadedLanguages.add(language);
                const callbacks = [...readyCallbacks];
                readyCallbacks.clear();
                callbacks.forEach((callback) => callback());
              }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (initialization === flight) initialization = undefined;
            }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
          ),
          Effect.withSpan("pi-code-previews.shiki.initialize", {
            attributes: { operation: "initialize" },
          }),
        );
      });

      const requestInitialize = (theme: string, invalidate?: () => void) => {
        if (invalidate) readyCallbacks.add(invalidate);
        if (initialization?.theme === theme) return;
        forkCodePreviewSessionEffect(
          CodePreviewSyntaxService.use((current) => current.initialize(theme)),
        );
      };
      const requestLanguage = (language: string, invalidate?: () => void) => {
        if (invalidate) {
          const callbacks = languageCallbacks.get(language) ?? new Set<() => void>();
          callbacks.add(invalidate);
          languageCallbacks.set(language, callbacks);
        }
        if (pendingLanguages.has(language) || !highlighter) return;
        const currentHighlighter = highlighter;
        const currentGeneration = generation;
        pendingLanguages.add(language);
        forkCodePreviewSessionEffect(
          adapter.loadLanguage(currentHighlighter, language).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (currentGeneration !== generation) return;
                loadedLanguages.add(language);
                statusVersion++;
                const callbacks = languageCallbacks.get(language);
                languageCallbacks.delete(language);
                callbacks?.forEach((callback) => callback());
              }),
            ),
            Effect.catch(() =>
              Effect.sync(() => {
                if (currentGeneration === generation) {
                  statusVersion++;
                  languageCallbacks.delete(language);
                }
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (currentGeneration === generation) pendingLanguages.delete(language);
              }),
            ),
          ),
        );
      };

      const render = (code: string, lang: string, invalidate?: () => void) => {
        if (!codePreviewSettings.syntaxHighlighting || shouldSkipHighlight(code)) return undefined;
        if (!highlighter) {
          requestInitialize(codePreviewSettings.shikiTheme, invalidate);
          return undefined;
        }
        const language = normalizePreviewLanguageAlias(lang);
        const key = `${codePreviewSettings.shikiTheme}\0${language}\0${code.length}\0${hashString(code)}`;
        const cached = renderCache.get(key);
        if (cached && isExactShikiCacheHit(cached, code)) {
          renderCache.delete(key);
          renderCache.set(key, cached);
          return cached.value;
        }
        try {
          if (!loadedLanguages.has(language)) requestLanguage(language, invalidate);
          const tokens = highlighter.codeToTokensBase(code, {
            lang: language as never,
            theme: codePreviewSettings.shikiTheme as never,
          });
          const rendered = tokens.map((line) =>
            normalizeContrast(
              line.map((token) => ansiFromToken(token)).join(""),
              codePreviewSettings.shikiTheme,
            ),
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
      };

      service = CodePreviewSyntaxService.of({
        initialize,
        render,
        status: () => ({
          initialized: Boolean(highlighter),
          cacheSize: renderCache.size,
          cacheLimit: codePreviewPerformanceConfig.cacheLimit,
          maxHighlightChars: codePreviewPerformanceConfig.maxHighlightChars,
          loadedLanguages: loadedLanguages.size,
          pendingLanguages: pendingLanguages.size,
          statusVersion,
        }),
        dispose,
      });
      activeSyntaxProjection = service;
      return yield* Effect.acquireRelease(Effect.succeed(service), (owned) =>
        owned.dispose.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (activeSyntaxProjection === owned) activeSyntaxProjection = undefined;
            }),
          ),
        ),
      );
    }),
  );
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
