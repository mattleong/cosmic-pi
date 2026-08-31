import {
  parseHerdrBtwParentFile,
  parseHerdrBtwSessionId,
  type ExtensionFlagValue,
} from "../btw/marker.ts";

export interface HerdrBtwParentReference {
  readonly path: string;
  readonly id: string;
}

export interface ParentReferenceCandidateInput {
  /** Raw extension CLI flag values; all markers must be valid strings. */
  readonly parentIdMarker: ExtensionFlagValue;
  readonly parentFileMarker: ExtensionFlagValue;
  readonly childSessionMarker: ExtensionFlagValue;
  /** The child session's own persisted identity. */
  readonly sessionId: string | null | undefined;
  readonly sessionFile: string | null | undefined;
}

/** Resolves bounded markers against the owning child session without host I/O. */
export const resolveParentReferenceCandidate = (
  input: ParentReferenceCandidateInput,
): HerdrBtwParentReference | undefined => {
  const marker = parseHerdrBtwSessionId(input.parentIdMarker);
  const childMarker = parseHerdrBtwSessionId(input.childSessionMarker);
  const parentPath = parseHerdrBtwParentFile(input.parentFileMarker);
  if (
    marker === undefined ||
    childMarker === undefined ||
    childMarker !== input.sessionId ||
    parentPath === undefined
  )
    return undefined;
  const ownSessionFile = input.sessionFile;
  if (ownSessionFile === null || ownSessionFile === undefined || ownSessionFile.length === 0)
    return undefined;
  return parentPath === ownSessionFile ? undefined : { path: parentPath, id: marker };
};

/** Stable reference-only instruction for a Herdr-created BTW session. */
export const parentReferenceInstruction = (parentPath: string, parentId: string): string =>
  [
    "## Live parent Pi session (Herdr side session)",
    "",
    "This blank Pi side session is linked to a live parent Pi session that continues running in another pane.",
    `- Parent session file: ${JSON.stringify(parentPath)}`,
    `- Expected parent session ID: ${parentId}`,
    "",
    "The parent session file is a live, append-only JSONL transcript. When current parent activity matters, inspect that file with normal read-only tools (for example the read tool, or read-only bash commands such as tail or rg). Never mutate, resume, or compact the parent session file, and never adopt it as this session's own file. This is reference-only context: no parent content is read or imported automatically.",
  ].join("\n");
