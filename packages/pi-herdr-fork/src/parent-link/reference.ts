// Pure fail-closed resolution of the live parent reference in a marked child.
import type { SessionHeaderProbe } from "../boundary/session-file.ts";
import {
  parseHerdrForkParentFile,
  parseHerdrForkSessionId,
  type ExtensionFlagValue,
} from "../fork/marker.ts";

export interface HerdrForkParentReference {
  readonly path: string;
  readonly id: string;
}

export interface ParentReferenceInput {
  /** Raw extension CLI flag values; both must be valid strings. */
  readonly parentIdMarker: ExtensionFlagValue;
  readonly parentFileMarker: ExtensionFlagValue;
  readonly childSessionMarker: ExtensionFlagValue;
  /** The child session's own persisted identity. */
  readonly sessionId: string | null | undefined;
  readonly sessionFile: string | null | undefined;
  /** Read-only, no-follow parent header probe. */
  readonly probe: (path: string) => SessionHeaderProbe;
}

/**
 * Requires both markers, a distinct parent file, and a probed regular
 * non-symlink parent header whose ID matches the ID marker. Any missing or
 * mismatched requirement deactivates the reference entirely.
 */
export const resolveParentReference = (
  input: ParentReferenceInput,
): HerdrForkParentReference | undefined => {
  const marker = parseHerdrForkSessionId(input.parentIdMarker);
  const childMarker = parseHerdrForkSessionId(input.childSessionMarker);
  const parentPath = parseHerdrForkParentFile(input.parentFileMarker);
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
  if (parentPath === ownSessionFile) return undefined;
  const probe = input.probe(parentPath);
  if (probe._tag !== "valid" || probe.header.id !== marker) return undefined;
  return { path: parentPath, id: marker };
};
