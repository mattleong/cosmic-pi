import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../session-capability";
import { codePreviewSettings } from "../settings";
import { expandPreviewTabs } from "../shared/preview-tabs";
import {
  CodePreviewSyntaxService,
  isLightShikiTheme,
  plainHighlightedText,
  shouldSkipHighlight,
  syntaxServiceProjection,
  type ShikiStatus,
} from "./service";
import { normalizePreviewLanguageAlias } from "./language";

export const initializeShikiEffect = Effect.fn("CodePreviewShiki.initializeFacade")(function* (
  theme: string,
) {
  const service = yield* CodePreviewSyntaxService;
  yield* service.initialize(theme);
});

export function initializeShiki(theme: string): Promise<void> {
  if (!hasCodePreviewSessionCapability()) return Promise.resolve();
  return runCodePreviewSessionEffect(initializeShikiEffect(theme));
}

export const disposeShikiEffect = CodePreviewSyntaxService.use((service) => service.dispose);

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
  return syntaxServiceProjection()?.render(code, lang, invalidate);
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
  return syntaxServiceProjection()?.status() ?? EMPTY_STATUS;
}

export { isLightShikiTheme, shouldSkipHighlight };
export function normalizeShikiLanguage(lang: string): string {
  return normalizePreviewLanguageAlias(lang);
}
