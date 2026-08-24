import type { ProjectionOwnership } from "../shared/projection-ownership";
import type { ExistingFilePreview } from "./diff";

type CodePreviewBeforeWrite = ExistingFilePreview | undefined;

export type CodePreviewWriteSnapshot = Readonly<{
  entries: ReadonlyArray<readonly [toolCallId: string, before: CodePreviewBeforeWrite]>;
}>;

let activeOwner: ProjectionOwnership | undefined;
let newestGeneration = 0;
let activeSnapshot: CodePreviewWriteSnapshot | undefined;

export function publishWriteProjection(
  owner: ProjectionOwnership,
  snapshot: CodePreviewWriteSnapshot,
): void {
  if (activeOwner?.key === owner.key) {
    activeSnapshot = snapshot;
    return;
  }
  // A newly acquired session takes over immediately. Retired or stale owners cannot rebind.
  if (owner.generation <= newestGeneration) return;
  newestGeneration = owner.generation;
  activeOwner = owner;
  activeSnapshot = snapshot;
}

export function clearWriteProjection(owner: ProjectionOwnership): void {
  if (activeOwner?.key !== owner.key) return;
  activeOwner = undefined;
  activeSnapshot = undefined;
}

/** Synchronous, non-destructive renderer lookup. Duplicate renders observe the same correlation. */
export function lookupBeforeWrite(toolCallId: string): CodePreviewBeforeWrite {
  const entries = activeSnapshot?.entries;
  if (!entries) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.[0] === toolCallId) return entry[1];
  }
  return undefined;
}
