import type { TruncationResult } from "@earendil-works/pi-coding-agent";

/** Two complete lines of a three-line, 13-byte file, truncated by the line limit. */
export const truncation = (overrides: Partial<TruncationResult> = {}): TruncationResult => ({
  content: "one\ntwo",
  truncated: true,
  truncatedBy: "lines",
  totalLines: 3,
  totalBytes: 13,
  outputLines: 2,
  outputBytes: 7,
  lastLinePartial: false,
  firstLineExceedsLimit: false,
  maxLines: 2_000,
  maxBytes: 51_200,
  ...overrides,
});
