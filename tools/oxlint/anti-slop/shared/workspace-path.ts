export function isWorkspaceFile(filename: string, paths: readonly string[]): boolean {
  const normalized = filename.replaceAll("\\", "/");
  return paths.some((path) => normalized.endsWith(`/${path}`));
}
