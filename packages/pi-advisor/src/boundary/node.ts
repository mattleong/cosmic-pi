// Synchronous, bounded instruction reads are confined to this explicit boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";

export const nodeDirname = dirname;
export const nodeJoin = join;

export function readTextFileBoundedStableOptionalSync(
  path: string,
  root: string,
  maximumBytes: number,
): { text: string; truncated: boolean } | undefined {
  let descriptor: number | undefined;
  try {
    const canonicalRoot = realpathSync(root);
    const relation = relative(resolve(root), resolve(path));
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return;
    let current = resolve(root);
    for (const component of relation.split(sep).filter(Boolean)) {
      current = resolve(current, component);
      if (lstatSync(current).isSymbolicLink()) return;
    }
    const beforePath = realpathSync(path);
    const canonicalRelation = relative(canonicalRoot, beforePath);
    if (
      canonicalRelation === ".." ||
      canonicalRelation.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelation)
    )
      return;
    const before = lstatSync(beforePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(beforePath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) return;
    const allocation = Buffer.allocUnsafe(maximumBytes + 1);
    const bytesRead = readSync(descriptor, allocation, 0, allocation.length, 0);
    const visible = lstatSync(realpathSync(path), { bigint: true });
    if (visible.dev !== opened.dev || visible.ino !== opened.ino) return;
    return {
      text: allocation.subarray(0, Math.min(bytesRead, maximumBytes)).toString("utf8"),
      truncated: bytesRead > maximumBytes,
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Compatibility reads are fail-open.
      }
    }
  }
}
