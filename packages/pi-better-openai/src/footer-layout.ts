import { sep } from "node:path";

export function abbreviateHomePath(
  path: string,
  home = process.env.HOME || process.env.USERPROFILE,
): string {
  if (!home) return path;
  if (path === home) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
}
