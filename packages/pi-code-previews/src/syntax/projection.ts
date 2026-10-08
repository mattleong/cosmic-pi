import type { ShikiHighlighter } from "../boundary/shiki";
import { ownedProjectionSlot, type ProjectionOwnership } from "../shared/projection-ownership";

type ShikiProjectionStatus = Readonly<{
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

const slot = ownedProjectionSlot<{
  snapshot: CodePreviewSyntaxSnapshot;
  requests: SyntaxRequests;
}>();

export function publishSyntaxProjection(
  owner: ProjectionOwnership,
  snapshot: CodePreviewSyntaxSnapshot,
): void {
  slot.write(owner, { snapshot });
}

export function installSyntaxRequests(owner: ProjectionOwnership, requests: SyntaxRequests): void {
  slot.write(owner, { requests });
}

export const clearSyntaxProjection = slot.clear;

export function syntaxProjection(): CodePreviewSyntaxSnapshot | undefined {
  return slot.read().snapshot;
}

export function requestSyntaxInitialize(theme: string, invalidate?: () => void): void {
  slot.read().requests?.initialize(theme, invalidate);
}

export function requestSyntaxLanguage(language: string, invalidate?: () => void): void {
  slot.read().requests?.language(language, invalidate);
}
