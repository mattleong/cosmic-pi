import type { ShikiHighlighter } from "../boundary/shiki";

export type ShikiProjectionStatus = Readonly<{
  initialized: boolean;
  loadedLanguages: number;
  pendingLanguages: number;
  statusVersion: number;
}>;

/**
 * Immutable renderer metadata plus the one unavoidable synchronous Shiki capability.
 * The highlighter is never frozen or mutated by renderers except through Shiki's synchronous
 * `codeToTokensBase`; all lifecycle and language loading remains owned by the session service.
 */
export type CodePreviewSyntaxSnapshot = Readonly<{
  generation: number;
  theme: string | undefined;
  highlighter: ShikiHighlighter | undefined;
  loadedLanguages: readonly string[];
  status: ShikiProjectionStatus;
}>;

type SyntaxRequests = Readonly<{
  initialize: (theme: string, invalidate?: () => void) => void;
  language: (language: string, invalidate?: () => void) => void;
}>;

let activeOwner: symbol | undefined;
let activeSnapshot: CodePreviewSyntaxSnapshot | undefined;
let activeRequests: SyntaxRequests | undefined;

export function publishSyntaxProjection(owner: symbol, snapshot: CodePreviewSyntaxSnapshot): void {
  activeOwner = owner;
  activeSnapshot = snapshot;
}

export function installSyntaxRequests(owner: symbol, requests: SyntaxRequests): void {
  activeOwner = owner;
  activeRequests = requests;
}

export function clearSyntaxProjection(owner: symbol): void {
  if (activeOwner !== owner) return;
  activeOwner = undefined;
  activeSnapshot = undefined;
  activeRequests = undefined;
}

export function syntaxProjection(): CodePreviewSyntaxSnapshot | undefined {
  return activeSnapshot;
}

export function requestSyntaxInitialize(theme: string, invalidate?: () => void): void {
  activeRequests?.initialize(theme, invalidate);
}

export function requestSyntaxLanguage(language: string, invalidate?: () => void): void {
  activeRequests?.language(language, invalidate);
}
