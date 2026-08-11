// Pure synchronous path predicates; the Effect Path service adds no value here.
// @effect-diagnostics effect/nodeBuiltinImport:off
import * as nodePath from "node:path";

/** Minimal path-module surface; satisfied by node:path and @effect/platform Path.Path. */
export interface PathContainmentAdapter {
  relative(root: string, candidate: string): string;
  isAbsolute(value: string): boolean;
  readonly sep: string;
}

const containmentRelation = (
  adapter: PathContainmentAdapter,
  root: string,
  candidate: string,
): "equal" | "inside" | "outside" => {
  const relation = adapter.relative(root, candidate);
  if (relation === "") return "equal";
  return relation !== ".." &&
    !relation.startsWith(`..${adapter.sep}`) &&
    !adapter.isAbsolute(relation)
    ? "inside"
    : "outside";
};

/** Equal-or-inside containment; unlike prefix matching this is correct on Windows and sibling roots. */
export const isContainedPathWith = (
  adapter: PathContainmentAdapter,
  root: string,
  candidate: string,
): boolean => containmentRelation(adapter, root, candidate) !== "outside";

export const isContainedPath = (root: string, candidate: string): boolean =>
  isContainedPathWith(nodePath, root, candidate);

/** Strict containment: candidate must be inside root, not root itself. */
export const isStrictlyInsidePathWith = (
  adapter: PathContainmentAdapter,
  root: string,
  candidate: string,
): boolean => containmentRelation(adapter, root, candidate) === "inside";

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
