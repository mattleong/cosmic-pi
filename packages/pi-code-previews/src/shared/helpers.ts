/** Small shared helpers used across preview rendering paths. */

export function getObjectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

export function isToolOutputNoticeLine(line: string): boolean {
  return line.startsWith("[") && line.endsWith("]");
}

export const PREVIEW_TAB_REPLACEMENT = "   ";

export function expandPreviewTabs(text: string): string {
  return text.replace(/\t/g, PREVIEW_TAB_REPLACEMENT);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Stable non-cryptographic string hash for cache keys. */
export function hashString(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(36)}${(first >>> 0).toString(36)}`;
}
