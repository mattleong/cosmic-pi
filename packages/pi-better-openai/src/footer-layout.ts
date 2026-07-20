/** Abbreviates conventional Unix home paths without consulting process globals. */
export function abbreviateHomePath(cwd: string): string {
  return cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
