import { nodeHomeDirectory, nodeIsAbsolute, nodeResolve } from "../boundary/node";

export function resolvePreviewPath(path: string, cwd: string): string {
  let expanded = path.startsWith("@") ? path.slice(1) : path;
  expanded = expanded.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (expanded === "~") expanded = nodeHomeDirectory();
  else if (expanded.startsWith("~/")) expanded = `${nodeHomeDirectory()}${expanded.slice(1)}`;
  return nodeIsAbsolute(expanded) ? expanded : nodeResolve(cwd, expanded);
}
