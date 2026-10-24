import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_SEQUENCE_CHARS,
  plainTerminalText,
  TerminalTextNormalizer,
} from "../src/task/terminal-text.ts";

const normalize = (...writes: string[]) => {
  const normalizer = new TerminalTextNormalizer();
  return Arr.join(
    Arr.map(writes, (write) => normalizer.write(write)),
    "",
  );
};

const characters = (text: string) => Array.from(text);

const VITE =
  "  \u001b[32m\u001b[1mVITE\u001b[22m v5.0.0\u001b[39m  \u001b[2mready in \u001b[0m\u001b[1m312\u001b[22m\u001b[2m ms\u001b[22m\r\n";

describe("terminal output normalization", () => {
  it("keeps text and colors and removes every other control or sequence", () => {
    const raw = Arr.join(
      [
        "\u001b]0;evil-title\u0007",
        "\u001b]8;;https://x.example/\u001b\\link\u001b]8;;\u001b\\",
        "\u001b[2J\u001b[H\u001b[?25l",
        "\u001bPq#0;2;0;0;0\u001b\\",
        "\u001b_private\u001b\\\u001b^pm\u001b\\\u001bXsos\u001b\\",
        "\u009d0;c1-title\u009c\u009b31mc1\u009b0m",
        "\u001b7\u001b(B",
        "a\tb\bc\r\n",
        "\u001b[31;1mred\u001b[0m\n",
      ],
      "",
    );
    const normalized = normalize(raw);
    expect(normalized).toBe("link\u001b[31mc1\u001b[0ma\tbc\n\u001b[31;1mred\u001b[0m\n");
    expect(plainTerminalText(normalized)).toBe("linkc1a\tbc\nred\n");
  });

  it("gives the same result however a write is split, including inside a sequence", () => {
    const raw = `${VITE}\u001b]0;title\u0007done\u001b[1Aup\n`;
    const whole = normalize(raw);
    expect(normalize(...characters(raw))).toBe(whole);
    for (let split = 1; split < raw.length; split++)
      expect(normalize(Fn.pipe(raw, Str.slice(0, split)), Fn.pipe(raw, Str.slice(split)))).toBe(
        whole,
      );
    expect(plainTerminalText(whole)).toBe("  VITE v5.0.0  ready in 312 ms\ndoneup\n");
  });

  it("turns progress redrawn with carriage returns into one line per update", () => {
    expect(normalize("Downloading  10%\rDownloading  55%\rDownloading 100%\n")).toBe(
      "Downloading  10%\nDownloading  55%\nDownloading 100%\n",
    );
    // Erasing the line after the return, as progress bars do, changes nothing.
    expect(plainTerminalText(normalize("\u001b[32m 10%\u001b[0m\r\u001b[2K 55%"))).toBe(
      " 10%\n 55%",
    );
  });

  it("keeps a CRLF, or a CR already at a line start, a single line break", () => {
    expect(normalize("one\r\ntwo\r\n\r\nfour\r\n")).toBe("one\ntwo\n\nfour\n");
    expect(normalize("\r 10%\r\r 55%\r\n")).toBe(" 10%\n 55%\n");
    expect(normalize("done\n\r\n")).toBe("done\n\n");
    // A CR that ends one write and the LF that starts the next form one break.
    expect(normalize("one\r", "\ntwo\r", "\u001b[0m", "\nthree")).toBe("one\ntwo\n\u001b[0mthree");
    expect(normalize("one\r", "\n", "\n")).toBe("one\n\n");
    const raw = "a\rb\r\nc\r\r\nd\n\re\r";
    const whole = normalize(raw);
    for (let split = 1; split < raw.length; split++)
      expect(normalize(Fn.pipe(raw, Str.slice(0, split)), Fn.pipe(raw, Str.slice(split)))).toBe(
        whole,
      );
    expect(normalize(...characters(raw))).toBe(whole);
  });

  it("keeps a line feed after lost output as a line break of its own", () => {
    const normalizer = new TerminalTextNormalizer();
    expect(normalizer.write("one\r")).toBe("one\n");
    normalizer.outputLost();
    // The lost output may have ended anywhere, so the line feed no longer pairs with the return.
    expect(normalizer.write("\ntwo\n")).toBe("\ntwo\n");
  });

  it("resumes after an unterminated sequence instead of swallowing later output", () => {
    const longTitle = `\u001b]0;${Fn.pipe("t", Str.repeat(MAX_PENDING_SEQUENCE_CHARS))}`;
    expect(plainTerminalText(normalize(longTitle, "after\n"))).toMatch(/after\n$/u);
    expect(normalize("\u001b]0;title", "\u001b[32mgreen\u001b[0m\n")).toBe(
      "\u001b[32mgreen\u001b[0m\n",
    );
    expect(normalize("\u001b[12", "\nnext\n")).toBe("\nnext\n");

    const interrupted = new TerminalTextNormalizer();
    expect(interrupted.write("\u001b]0;half")).toBe("");
    interrupted.outputLost();
    expect(interrupted.write("visible\n")).toBe("visible\n");
  });
});
