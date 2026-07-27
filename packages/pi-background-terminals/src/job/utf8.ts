/** Pure UTF-8 byte accounting shared by the job log buffer and the process boundary. */

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function utf8Tail(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  const characters = [...text];
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const character = characters[start - 1] ?? "";
    const size = utf8ByteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return { text: characters.slice(start).join(""), bytes };
}
