import type { ShikiHighlighter } from "../boundary/shiki";
import type { ProjectionOwnership } from "../shared/projection-ownership";

export type ShikiProjectionStatus = Readonly<{
  initialized: boolean;
  loadedLanguages: number;
  pendingLanguages: number;
  statusVersion: number;
}>;

export type ShikiStatus = ShikiProjectionStatus &
  Readonly<{
    cacheSize: number;
    cacheLimit: number;
    maxHighlightChars: number;
  }>;

/**
 * Immutable renderer metadata plus the one unavoidable synchronous Shiki capability.
 * The highlighter is never frozen or mutated by renderers except through Shiki's synchronous
 * `codeToTokensBase`; all lifecycle and language loading remains owned by the session service.
 */
export type CodePreviewSyntaxSnapshot = Readonly<{
  theme: string | undefined;
  highlighter: ShikiHighlighter | undefined;
  loadedLanguages: readonly string[];
  /** Session failures that renderers show as plain text instead of requesting again. */
  failedThemes: readonly string[];
  failedLanguages: readonly string[];
  status: ShikiProjectionStatus;
}>;

type SyntaxRequests = Readonly<{
  initialize: (theme: string, invalidate?: () => void) => void;
  language: (language: string, invalidate?: () => void) => void;
}>;

let activeOwner: ProjectionOwnership | undefined;
let newestGeneration = 0;
let activeSnapshot: CodePreviewSyntaxSnapshot | undefined;
let activeRequests: SyntaxRequests | undefined;

const claimOwnership = (owner: ProjectionOwnership): boolean => {
  if (activeOwner?.key === owner.key) return true;
  // A newly acquired session takes over immediately. Retired or stale owners cannot rebind.
  if (owner.generation <= newestGeneration) return false;
  newestGeneration = owner.generation;
  activeOwner = owner;
  activeSnapshot = undefined;
  activeRequests = undefined;
  return true;
};

export function publishSyntaxProjection(
  owner: ProjectionOwnership,
  snapshot: CodePreviewSyntaxSnapshot,
): void {
  if (!claimOwnership(owner)) return;
  activeSnapshot = snapshot;
}

export function installSyntaxRequests(owner: ProjectionOwnership, requests: SyntaxRequests): void {
  if (!claimOwnership(owner)) return;
  activeRequests = requests;
}

export function clearSyntaxProjection(owner: ProjectionOwnership): void {
  if (activeOwner?.key !== owner.key) return;
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
