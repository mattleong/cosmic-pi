// Synchronous Node compatibility helpers are confined to this explicit boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/globalConsole:off
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from "node:path";

export const nodeDirname = dirname;
export const nodeJoin = join;
export const nodeRelative = relative;
export const nodeResolve = resolve;
export const nodeSep = sep;
export const nodeIsAbsolute = isAbsolute;

export function readTextFileOptionalSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

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

export function writeTextFileAtomicSync(path: string, text: string): void {
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed || basename(directory) === "extensions") chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function warnSyncBoundary(message: string): void {
  console.warn(message);
}

export function appendRotatingTextSync(path: string, text: string, maximumBytes: number): boolean {
  try {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    if (existsSync(path) && statSync(path).size >= maximumBytes) {
      const previous = `${path}.1`;
      rmSync(previous, { force: true });
      renameSync(path, previous);
      chmodSync(previous, 0o600);
    }
    appendFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}
