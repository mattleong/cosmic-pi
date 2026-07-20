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

export function sanitizeDiagnosticError(message: string, maximumLength = 500): string {
  return sanitizeCoreDiagnosticError(message, { maximumLength });
}
