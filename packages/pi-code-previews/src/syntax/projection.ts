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

export type CodePreviewSyntaxSnapshot = Readonly<{
  theme: string | undefined;
  highlighter: ShikiHighlighter | undefined;
  loadedLanguages: readonly string[];
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
