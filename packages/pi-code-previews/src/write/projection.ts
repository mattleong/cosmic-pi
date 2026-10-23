import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { ownedProjectionSlot, type ProjectionOwnership } from "../shared/projection-ownership";
import type { ExistingFilePreview } from "./diff";

export type CodePreviewBeforeWrite = ExistingFilePreview | undefined;

export type CodePreviewWriteSnapshot = Readonly<{
  entries: ReadonlyArray<readonly [toolCallId: string, before: CodePreviewBeforeWrite]>;
}>;

const slot = ownedProjectionSlot<{ snapshot: CodePreviewWriteSnapshot }>();

export function publishWriteProjection(
  owner: ProjectionOwnership,
  snapshot: CodePreviewWriteSnapshot,
): void {
  slot.write(owner, { snapshot });
}

export const clearWriteProjection = slot.clear;

export function lookupBeforeWrite(toolCallId: string): CodePreviewBeforeWrite {
  const entries = slot.read().snapshot?.entries;
  if (entries === undefined) return undefined;
  return Option.getOrUndefined(Arr.findLast(entries, ([id]) => id === toolCallId))?.[1];
}
