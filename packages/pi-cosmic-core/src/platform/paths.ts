import { nodeDisplayHomeDirectory, nodePath } from "./node-builtins.ts";

interface PathContainmentAdapter {
  relative(root: string, candidate: string): string;
  isAbsolute(value: string): boolean;
  readonly sep: string;
}

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

export function abbreviateHomePath(path: string, home?: string): string {
  if (!home) return path;
  if (path === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

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
    if (isStrictlyInsidePath(root, path)) return `${prefix}${relative}`;
  }
  return path;
}
