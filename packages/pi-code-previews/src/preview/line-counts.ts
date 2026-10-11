import { forEachRawTextLine } from "../shared/text-lines";

export function countContentLines(content: string): number {
  if (!content) return 0;
  let newlines = 0;
  for (let index = content.indexOf("\n"); index >= 0; index = content.indexOf("\n", index + 1))
    newlines++;
  return newlines + (content.endsWith("\n") ? 0 : 1);
}

export function forEachPreviewTextLine(
  text: string,
  callback: (line: string, index: number) => void,
): void {
  let index = 0;
  let pendingEmpty = 0;
  forEachRawTextLine(text, (line) => {
    if (line === "") {
      pendingEmpty++;
      return;
    }
    while (pendingEmpty > 0) {
      callback("", index++);
      pendingEmpty--;
    }
    callback(line, index++);
  });
  if (index === 0 && pendingEmpty > 0 && text.length > 0) callback("", index);
}
