// Synchronous host/process projection required by Pi rendering and compatibility tests.
// Production configuration is decoded once by CodePreviewEnvironmentService.
export function environmentValue(name: string): string | undefined {
  const environment = Reflect.get(process, "env") as Record<string, string | undefined>;
  return environment[name];
}

export function currentWorkingDirectory(): string {
  return process.cwd();
}

export function warnBoundary(message: string): void {
  const warn = Reflect.get(console, "warn") as (message: string) => void;
  warn(message);
}

export function setEnvironmentValueForTest(name: string, value: string | undefined): void {
  const environment = Reflect.get(process, "env") as Record<string, string | undefined>;
  if (value === undefined) delete environment[name];
  else environment[name] = value;
}
