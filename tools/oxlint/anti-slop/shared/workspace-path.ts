export function isWorkspaceFile(filename: string, paths: readonly string[]): boolean {
  return paths.some((path) => filename.endsWith(`/${path}`));
}
