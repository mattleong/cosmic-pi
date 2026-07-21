import type { ExistingFilePreview } from "./diff";

type CodePreviewBeforeWrite = ExistingFilePreview | undefined;

export type CodePreviewWriteSnapshot = Readonly<{
  entries: ReadonlyArray<readonly [toolCallId: string, before: CodePreviewBeforeWrite]>;
}>;

let activeOwner: symbol | undefined;
let activeSnapshot: CodePreviewWriteSnapshot | undefined;

export function publishWriteProjection(owner: symbol, snapshot: CodePreviewWriteSnapshot): void {
  activeOwner = owner;
  activeSnapshot = snapshot;
}

export function clearWriteProjection(owner: symbol): void {
  if (activeOwner !== owner) return;
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

export function writeProjectionSize(): number {
  return activeSnapshot?.entries.length ?? 0;
}
