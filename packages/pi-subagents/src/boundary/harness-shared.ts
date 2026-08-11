// Shared private-filesystem and harness helpers for boundary services.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const MAX_AUTH_BYTES = 64 * 1024;
export const MAX_PATH_CHARS = 4_096;

const SUPERVISOR_NATIVE_TOOLS = [
  "mcp__pi_subagents_supervisor__supervisor_progress",
  "mcp__pi_subagents_supervisor__supervisor_warning",
  "mcp__pi_subagents_supervisor__supervisor_question",
  "mcp__pi_subagents_supervisor__supervisor_submit_report",
] as const;
export const CLAUDE_INSPECTION_TOOLS: ReadonlyArray<string> = [
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  ...SUPERVISOR_NATIVE_TOOLS,
];
export const CLAUDE_READ_TOOLS: ReadonlyArray<string> = ["Bash", ...CLAUDE_INSPECTION_TOOLS];
export const CLAUDE_WRITE_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "Edit",
  ...CLAUDE_INSPECTION_TOOLS,
];
export const CLAUDE_DENIED_TOOLS: ReadonlyArray<string> = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
  "Chrome",
  "NotebookEdit",
  "Write",
];

export const nodeErrorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });

export const ensurePrivateDirectory = async (path: string): Promise<void> => {
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-private-directory");
  await fs.chmod(path, 0o700);
};

export const writeExclusive = async (path: string, source: string): Promise<void> => {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(source, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(path, 0o600);
};

export const safeAgentDirectory = async (agentDirectory: string): Promise<string> => {
  if (
    !isAbsolute(agentDirectory) ||
    agentDirectory.length < 1 ||
    agentDirectory.length > MAX_PATH_CHARS ||
    hasControlCharacter(agentDirectory)
  )
    throw new Error("invalid-agent-directory");
  const requested = resolve(agentDirectory);
  const requestedStat = await fs.lstat(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink())
    throw new Error("unsafe-agent-directory");
  const canonical = await fs.realpath(requested);
  const canonicalStat = await fs.lstat(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink())
    throw new Error("unsafe-agent-directory");
  return canonical;
};

export const boundedJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 1_024 && value.every((entry) => boundedJsonValue(entry, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1_024 &&
    entries.every(([key, entry]) => key.length <= 1_024 && boundedJsonValue(entry, depth + 1))
  );
};

export const safeCodexSourceHome = async (
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const configured = sourceEnvironment.CODEX_HOME;
  const source =
    configured === undefined ? join(sourceEnvironment.HOME || homedir(), ".codex") : configured;
  if (
    !isAbsolute(source) ||
    source.length < 1 ||
    source.length > MAX_PATH_CHARS ||
    hasControlCharacter(source)
  )
    return undefined;
  try {
    const requested = resolve(source);
    const requestedStat = await fs.lstat(requested);
    if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) return undefined;
    const canonical = await fs.realpath(requested);
    const canonicalStat = await fs.lstat(canonical);
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
};

const readValidatedCodexAuthFromHome = async (sourceHome: string): Promise<string | undefined> => {
  const path = join(sourceHome, "auth.json");
  let bytes: Buffer;
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 1 || stat.size > MAX_AUTH_BYTES)
      return undefined;
    bytes = await fs.readFile(path);
  } catch {
    return undefined;
  }
  if (bytes.length <= 1 || bytes.length > MAX_AUTH_BYTES) return undefined;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) || !boundedJsonValue(value))
      return undefined;
    return `${JSON.stringify(value)}\n`;
  } catch {
    return undefined;
  }
};

export const readValidatedCodexAuth = async (
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const sourceHome = await safeCodexSourceHome(sourceEnvironment);
  return sourceHome ? readValidatedCodexAuthFromHome(sourceHome) : undefined;
};

export const harnessCleanupUnconfirmed = (
  cause: unknown,
): Error & { readonly cleanupUnconfirmed: true } =>
  Object.assign(new Error("Partial private harness cleanup could not be confirmed.", { cause }), {
    cleanupUnconfirmed: true as const,
  });

export const isHarnessCleanupUnconfirmed = (
  error: unknown,
): error is Error & { readonly cleanupUnconfirmed: true } =>
  error instanceof Error && "cleanupUnconfirmed" in error && error.cleanupUnconfirmed === true;
