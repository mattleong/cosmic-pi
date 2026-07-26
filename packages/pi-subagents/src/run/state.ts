import { freezeSnapshot, sanitizeDiagnosticError, stripTerminalControls } from "pi-cosmic-core";
import type { SubagentRunView, SubagentUsage } from "./model.ts";
import type { RpcUsage } from "./protocol.ts";

export const MAX_NAME_CHARS = 80;
export const MAX_TASK_CHARS = 128 * 1024;
export const MAX_FINAL_TEXT_CHARS = 32 * 1024;
export const MAX_ERROR_CHARS = 8 * 1024;

export const sanitizeName = (value: string): string => {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized += code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }
  return sanitized.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
};

export const snapshotView = (view: SubagentRunView): SubagentRunView =>
  freezeSnapshot({
    ...view,
    capabilities: [...view.capabilities],
    transcript: [...view.transcript],
    sessionEvents: view.sessionEvents.map((event) => ({ ...event })),
    usage: { ...view.usage },
  });

export const clipText = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

export const sanitizeDiagnosticText = (value: string, limit: number): string =>
  sanitizeDiagnosticError(value, { maximumLength: limit });

export const sanitizeOutputText = (value: string, limit: number): string =>
  clipText(stripTerminalControls(value), limit);

export const usageFromMessage = (usage: RpcUsage | undefined): SubagentUsage => ({
  input: usage?.input ?? 0,
  output: usage?.output ?? 0,
  cacheRead: usage?.cacheRead ?? 0,
  cacheWrite: usage?.cacheWrite ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
  cost: usage?.cost?.total ?? 0,
});

const isValidUsage = (usage: SubagentUsage): boolean =>
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) &&
  Number.isFinite(usage.cost) &&
  usage.cost >= 0;

export const addUsage = (left: SubagentUsage, right: SubagentUsage): SubagentUsage => {
  if (!isValidUsage(right)) return left;
  const combined: SubagentUsage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
  };
  return isValidUsage(combined) ? combined : left;
};
