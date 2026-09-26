import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getCapabilities, imageFallback } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";

import { getObjectValue } from "../../shared/helpers";

export function isTruncated<DetailsInput>(details: DetailsInput): boolean {
  const truncation = getObjectValue(details, "truncation");
  return getObjectValue(truncation, "truncated") === true;
}

export function getEditDiff<DetailsInput>(details: DetailsInput): string | undefined {
  const diff = getObjectValue(details, "diff");
  return Predicate.isString(diff) ? diff : undefined;
}

export function getTextContent(
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined,
): string {
  return (
    content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}

/** Native images remain host-owned; describe attachments when native display is unavailable. */
export function getFallbackResultText(
  content: AgentToolResult<unknown>["content"],
  showImages: boolean,
): string {
  const text = getTextContent(content);
  if (showImages && getCapabilities().images) return text;
  const images = content.flatMap((part) =>
    part.type === "image" ? [imageFallback(part.mimeType)] : [],
  );
  return [text, ...images].filter(Boolean).join("\n");
}

/** Decline summary parsing rather than silently dropping output outside the budget. */
export function getBoundedTextContent(
  content: Array<{ type: string; text?: string }> | undefined,
  maxChars = 128 * 1024,
): string | undefined {
  if (!content) return "";
  if (content.length > 128) return undefined;
  const texts: string[] = [];
  let chars = 0;
  for (const part of content) {
    if (part.type !== "text") continue;
    const text = part.text ?? "";
    chars += text.length + (texts.length > 0 ? 1 : 0);
    if (chars > maxChars) return undefined;
    texts.push(text);
  }
  return texts.join("\n");
}

const READ_CONTINUATION_NOTICE =
  /^\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]$/;

export function splitReadContinuationNotice(text: string) {
  const match = /^(.*?)(?:\r?\n){2}(\[[^\r\n]+\])$/s.exec(text);
  const notice = match?.[2];
  if (!match || !notice || !READ_CONTINUATION_NOTICE.test(notice)) return { content: text };
  return { content: match[1] ?? "", notice: notice.slice(1, -1) };
}
