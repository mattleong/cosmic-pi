import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
import type { ShikiHighlighter } from "../../src/boundary/shiki";

const inertHighlighter = await createHighlighter({
  themes: [],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});

export const shikiHighlighterFixture = (
  overrides: Partial<Pick<ShikiHighlighter, "codeToTokensBase" | "dispose" | "loadLanguage">>,
): ShikiHighlighter => ({ ...inertHighlighter, ...overrides });
