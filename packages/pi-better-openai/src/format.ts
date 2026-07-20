import {
  truncateToWidth as truncateTerminalText,
  visibleWidth as terminalVisibleWidth,
} from "@earendil-works/pi-tui";
import {
  maskIdentifier,
  redactDiagnosticValue,
  sanitizeDiagnosticError as sanitizeCoreDiagnosticError,
  stripAnsi,
} from "pi-cosmic-core";

export { maskIdentifier, redactDiagnosticValue, stripAnsi };

export function visibleWidth(value: string): number {
  return terminalVisibleWidth(value);
}

export function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  return truncateTerminalText(value, width, ellipsis);
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function sanitizeStatusText(text: string): string {
  return text.replace(/[ \r\n\t]+/g, " ").trim();
}

export function sanitizeDiagnosticError(message: string, maximumLength = 500): string {
  return sanitizeCoreDiagnosticError(message, { maximumLength });
}
