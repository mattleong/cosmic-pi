import { stripTerminalControls } from "pi-cosmic-core";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { FormField, FormValue, OwnedFormRequest } from "../questionnaire/form-protocol.ts";

export const displayFormValue = (value: FormValue | undefined): string =>
  value === undefined ? "(omitted)" : stripTerminalControls(JSON.stringify(value));

export function formFieldInstructions(field: FormField): string {
  const lines = [field.title ?? field.key, field.description ?? ""];
  if (field.type === "string") {
    lines.push(`Text length: ${field.minLength ?? 0} to ${field.maxLength ?? 4096}`);
    if (field.format) lines.push(`Format: ${field.format}`);
  }
  if (field.type === "number" || field.type === "integer") {
    if (field.minimum !== undefined) lines.push(`Minimum: ${field.minimum}`);
    if (field.maximum !== undefined) lines.push(`Maximum: ${field.maximum}`);
  }
  if (field.type === "multi-enum")
    lines.push(`Selection count: ${field.minItems ?? 0} to ${field.maxItems ?? 64}`);
  return stripTerminalControls(lines.join("\n"));
}

/** Plain text only: URLs are inert and never OSC hyperlinks. */
export function formIntroduction(request: OwnedFormRequest, width: number): string[] {
  const text =
    request.kind === "url"
      ? `${request.url}\nAccept consents to opening this URL in your browser.\n${request.message}`
      : request.message;
  return stripTerminalControls(text)
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}
