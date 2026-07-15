import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandTildePath(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export function piAgentDir(env = process.env, home = homedir()): string {
  const configuredDir = env.PI_CODING_AGENT_DIR?.trim();
  return configuredDir ? expandTildePath(configuredDir, home) : join(home, ".pi", "agent");
}

export function resolveUserPath(path: string, cwd: string, home = homedir()): string {
  return resolve(cwd, expandTildePath(path, home));
}
