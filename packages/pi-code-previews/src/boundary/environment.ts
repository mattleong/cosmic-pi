// Synchronous host/process projection required by Pi rendering.
// Configuration is decoded once by CodePreviewEnvironmentService.
export function currentWorkingDirectory(): string {
  return process.cwd();
}
