import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CompactIssue } from "./compact-issues";

const HEADER =
  /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/;
const SAVED_FOOTER = /\n\n\[Full output: [^\n]*\]$/;
const UNSAVED_FOOTER = "\n\n[Could not save the full output: ";

/**
 * Pi's native middle truncation, shared by codemode and MCP: a header, the kept start and end
 * of the text, then a footer saying where the full text was saved or why it couldn't be.
 */
type NativeTruncatedOutput =
  | { readonly body: string; readonly footer: "saved" | "unknown" }
  | { readonly body: string; readonly footer: "unsaved"; readonly reason: string };

/** Only the footer is read for recovery; the kept body may quote any text, including footers. */
export function parseNativeTruncatedOutput(text: string): NativeTruncatedOutput | undefined {
  const header = HEADER.exec(text);
  if (!header) return undefined;
  const rest = text.slice(header[0].length);
  const saved = SAVED_FOOTER.exec(rest);
  if (saved) return { body: rest.slice(0, saved.index), footer: "saved" };
  const unsaved = rest.lastIndexOf(UNSAVED_FOOTER);
  if (unsaved >= 0 && rest.endsWith("]"))
    return {
      body: rest.slice(0, unsaved),
      footer: "unsaved",
      reason: rest.slice(unsaved + UNSAVED_FOOTER.length, -1),
    };
  return { body: rest, footer: "unknown" };
}

/**
 * Clipping is informational when bounded native metadata names where the full output was saved.
 * A missing path, or Pi's footer saying the save failed, keeps it a warning.
 */
export function nativeTruncationIssues(
  envelope: NativeTruncatedOutput | undefined,
  fullOutputPath: string | undefined,
  producer: { readonly code: "native" | "mcp"; readonly subject: "Script output" | "Output" },
): CompactIssue[] {
  const truncated: CompactIssue = {
    severity: "warning",
    code: `${producer.code}-output-truncated`,
    message: `${producer.subject} is truncated`,
  };
  if (fullOutputPath && envelope?.footer !== "unsaved")
    return [
      {
        ...truncated,
        severity: "info",
        detail: `Full output saved to ${sanitizeDiagnosticContent(fullOutputPath)}`,
      },
    ];
  if (!envelope) return [];
  if (envelope.footer !== "unsaved") return [truncated];
  return [
    truncated,
    {
      severity: "warning",
      code: `${producer.code}-output-save-failed`,
      message: `Full ${producer.subject.toLowerCase()} couldn't be saved`,
      detail: sanitizeDiagnosticContent(envelope.reason),
    },
  ];
}
