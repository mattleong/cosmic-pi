import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CompactIssue } from "./compact-issues";

const HEADER =
  /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/;
const SAVED_FOOTER = /\n\n\[Full output: [^\n]*\]$/;
const UNSAVED_FOOTER = "\n\n[Could not save the full output: ";

type NativeTruncatedOutput =
  | { readonly body: string; readonly footer: "saved" | "unknown" }
  | { readonly body: string; readonly footer: "unsaved"; readonly reason: string };

export function parseNativeTruncatedOutput(text: string): NativeTruncatedOutput | undefined {
  const header = HEADER.exec(text);
  if (!header) return undefined;
  const rest = Fn.pipe(text, Str.slice(header[0].length));
  const saved = SAVED_FOOTER.exec(rest);
  if (saved) return { body: Fn.pipe(rest, Str.slice(0, saved.index)), footer: "saved" };
  const unsaved = Fn.pipe(rest, Str.lastIndexOf(UNSAVED_FOOTER));
  if (Option.isSome(unsaved) && Fn.pipe(rest, Str.endsWith("]")))
    return {
      body: Fn.pipe(rest, Str.slice(0, unsaved.value)),
      footer: "unsaved",
      reason: Fn.pipe(rest, Str.slice(unsaved.value + UNSAVED_FOOTER.length, -1)),
    };
  return { body: rest, footer: "unknown" };
}

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
      message: `Full ${Str.toLowerCase(producer.subject)} couldn't be saved`,
      detail: sanitizeDiagnosticContent(envelope.reason),
    },
  ];
}
