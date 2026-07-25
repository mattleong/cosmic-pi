const MAX_TRANSCRIPT_LINES = 500;
const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_SINGLE_LINE_CHARS = 4_000;

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const clipLine = (line: string): string =>
  line.length <= MAX_SINGLE_LINE_CHARS ? line : `${line.slice(0, MAX_SINGLE_LINE_CHARS)}…`;

export function appendTranscript(
  current: ReadonlyArray<string>,
  text: string,
): ReadonlyArray<string> {
  const additions = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map(clipLine)
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
  const next = [...current, ...additions].slice(-MAX_TRANSCRIPT_LINES);
  let retainedBytes = 0;
  let start = next.length;
  while (start > 0) {
    const size = bytes(next[start - 1] ?? "") + 1;
    if (retainedBytes + size > MAX_TRANSCRIPT_BYTES) break;
    retainedBytes += size;
    start -= 1;
  }
  return next.slice(start);
}
