/** UTF-8 byte accounting shared by the job log buffer and the process boundary. */

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const codePointByteLength = (code: number): number =>
  code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;

export function utf8Tail(text: string, maxBytes: number) {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  const totalBytes = utf8ByteLength(text);
  if (totalBytes <= maxBytes) return { text, bytes: totalBytes };
  const characters = [...text];
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const character = characters[start - 1] ?? "";
    const size = codePointByteLength(character.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return { text: characters.slice(start).join(""), bytes };
}
