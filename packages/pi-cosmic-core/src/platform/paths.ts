// Pure synchronous path predicates; the Effect Path service adds no value here.
import { nodeDisplayHomeDirectory, nodePath } from "./node-builtins.ts";

/** Minimal path-module surface; satisfied by node:path and @effect/platform Path.Path. */
export interface PathContainmentAdapter {
  relative(root: string, candidate: string): string;
  isAbsolute(value: string): boolean;
  readonly sep: string;
}

/** Strict containment: candidate must be inside root, not root itself. Unlike prefix matching
 * this is correct on Windows and for sibling roots. */
export const isStrictlyInsidePathWith = (
  adapter: PathContainmentAdapter,
  root: string,
  candidate: string,
): boolean => {
  const relation = adapter.relative(root, candidate);
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${adapter.sep}`) &&
    !adapter.isAbsolute(relation)
  );
};

export const isStrictlyInsidePath = (root: string, candidate: string): boolean =>
  isStrictlyInsidePathWith(nodePath, root, candidate);

/** Home-directory-aware display shortening; leaves the path untouched when it is not under home. */
export function abbreviateHomePath(path: string, home?: string): string {
  if (!home) return path;
  if (path === home) return "~";
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const prefix = home.endsWith(separator) ? home : `${home}${separator}`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

const isParentRelative = (path: string) =>
  path === ".." || path.startsWith("../") || path.startsWith("..\\");

/**
 * A path as users read it: relative to `cwd` when inside it ("src/a.ts", or "." for `cwd`
 * itself), else under the home directory ("~/notes/a.md"), else unchanged.
 */
export function formatDisplayPath(
  path: string,
  cwd: string,
  home = nodeDisplayHomeDirectory(),
): string {
  if (!path || !nodePath.isAbsolute(path)) return path;
  for (const [root, prefix] of [
    [cwd, ""],
    [home, "~/"],
  ] as const) {
    if (!root) continue;
    const relative = nodePath.relative(root, path);
    if (!relative) return prefix ? "~" : ".";
    if (!isParentRelative(relative) && !nodePath.isAbsolute(relative))
      return `${prefix}${relative}`;
  }
  return path;
}
