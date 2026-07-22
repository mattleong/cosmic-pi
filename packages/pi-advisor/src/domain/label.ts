import { redactSensitiveText } from "../review/observation-protocol.ts";

export const MAX_ADVISOR_LABEL_CHARS = 256;

export function safeAdvisorLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactSensitiveText(value);
  return redacted.length <= MAX_ADVISOR_LABEL_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_ADVISOR_LABEL_CHARS - 18)}[... truncated]`;
}
