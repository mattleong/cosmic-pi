export const COLLAPSED_BACKGROUND_LOG_LINES = 12;

export interface BackgroundLogPreview {
  readonly text: string;
  readonly shown: number;
  readonly hidden: number;
  readonly total: number;
}

const trimSingleTrailingNewline = (text: string): string => {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
};

export function selectBackgroundLogPreview(text: string, expanded: boolean): BackgroundLogPreview {
  const normalized = trimSingleTrailingNewline(text);
  const lines = normalized.split("\n");
  const total = lines.length;
  if (expanded || total <= COLLAPSED_BACKGROUND_LOG_LINES) {
    return { text: normalized, shown: total, hidden: 0, total };
  }

  const headCount = Math.ceil(COLLAPSED_BACKGROUND_LOG_LINES * 0.65);
  const tailCount = COLLAPSED_BACKGROUND_LOG_LINES - headCount;
  const hidden = total - headCount - tailCount;
  const selected = [
    ...lines.slice(0, headCount),
    `      --- ${hidden} lines hidden ---`,
    ...lines.slice(total - tailCount),
  ];
  return {
    text: selected.join("\n"),
    shown: headCount + tailCount,
    hidden,
    total,
  };
}
