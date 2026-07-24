/** Remove terminal controls from process-owned text before host or model rendering. */
export function sanitizeTerminalText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x9b) {
      index += 1;
      while (index < text.length) {
        const current = text.charCodeAt(index);
        if (current >= 0x40 && current <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      index += 1;
      while (index < text.length) {
        const current = text.charCodeAt(index);
        if (current === 0x07 || current === 0x9c) break;
        if (current === 0x1b && text[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (code === 0x1b) {
      const introducer = text[index + 1];
      if (introducer === "[") {
        index += 2;
        while (index < text.length) {
          const current = text.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
        continue;
      }
      if (["]", "P", "X", "^", "_"].includes(introducer ?? "")) {
        index += 2;
        while (index < text.length) {
          const current = text.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && text[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    const character = text[index] ?? "";
    if (
      character === "\n" ||
      character === "\t" ||
      (code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f))
    ) {
      result += character;
    }
  }
  return result;
}

export const sanitizeTerminalLine = (text: string): string =>
  sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
