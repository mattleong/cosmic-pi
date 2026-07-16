import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_LOG_BYTES = 1_000_000;
const MAX_ERROR_MESSAGE_CHARS = 4_000;
const MAX_ERROR_STACK_CHARS = 16_000;

export interface AdvisorFailureDetails {
  contextChars: number;
  durationMs: number;
  error: unknown;
  model?: string;
  provider?: string;
  timeoutMs: number;
}

export function getAdvisorFailureLogPath(configPath: string): string {
  return join(dirname(dirname(configPath)), "logs", "pi-advisor.jsonl");
}

/** Append a bounded diagnostic entry without ever disrupting the advisor failure path. */
export function logAdvisorFailure(
  configPath: string,
  details: AdvisorFailureDetails,
): string | undefined {
  const logPath = getAdvisorFailureLogPath(configPath);
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    rotateLogIfNeeded(logPath);
    const error = serializeError(details.error);
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        provider: details.provider,
        model: details.model,
        timeoutMs: details.timeoutMs,
        contextChars: details.contextChars,
        durationMs: Math.round(details.durationMs),
        error,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return logPath;
  } catch {
    return undefined;
  }
}

function rotateLogIfNeeded(logPath: string): void {
  if (!existsSync(logPath) || statSync(logPath).size < MAX_LOG_BYTES) return;
  const previousPath = `${logPath}.1`;
  rmSync(previousPath, { force: true });
  renameSync(logPath, previousPath);
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: clip(String(error), MAX_ERROR_MESSAGE_CHARS) };
  }
  return {
    name: error.name || "Error",
    message: clip(error.message, MAX_ERROR_MESSAGE_CHARS),
    ...(error.stack ? { stack: clip(error.stack, MAX_ERROR_STACK_CHARS) } : {}),
  };
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}
