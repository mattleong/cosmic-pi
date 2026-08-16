import { isStringValue } from "pi-cosmic-core";
import { getObjectValue } from "../../shared/helpers";

export function isTruncated<DetailsInput>(details: DetailsInput): boolean {
  const truncation = getObjectValue(details, "truncation");
  return getObjectValue(truncation, "truncated") === true;
}

export function getEditDiff<DetailsInput>(details: DetailsInput): string | undefined {
  const diff = getObjectValue(details, "diff");
  return isStringValue(diff) ? diff : undefined;
}

export function getTextContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  return (
    content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}

const READ_CONTINUATION_NOTICE =
  /^\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]$/;

export function splitReadContinuationNotice(text: string) {
  const match = /^(.*?)(?:\r?\n){2}(\[[^\r\n]+\])$/s.exec(text);
  const notice = match?.[2];
  if (!match || !notice || !READ_CONTINUATION_NOTICE.test(notice)) return { content: text };
  return { content: match[1] ?? "", notice: notice.slice(1, -1) };
}
