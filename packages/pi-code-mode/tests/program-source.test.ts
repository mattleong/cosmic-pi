import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { stripTerminalControls } from "pi-cosmic-core";
import { CODE_MODE_INTEGER_BOUNDS } from "../src/config/schema.ts";
import { truncateDisplay } from "../src/tools/format.ts";
import { formatCodeModeProgram } from "../src/ui/program-source.ts";

const semanticTree = (source: string): string =>
  JSON.stringify(
    parse(source, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }),
    (key, value) => (key === "start" || key === "end" ? undefined : value),
  );

describe("formatCodeModeProgram", () => {
  it.each([
    'const s = `literal;\n${"embedded;"}`; return s;',
    "const r = /a;[b/]/g; /* comment; */ return r;",
    "let x = 1; // line comment;\nx++; return x;",
    "let x = 1\nx++\nreturn\nx",
    "const f = () => 1; f()\n[1].forEach(f); return f;",
    "if (true) { work(); other(); } else { stop(); } return 1;",
    "do { work(); } while (false); return 1;",
    "const a = 1; /* multiline\ncomment */ return a;",
  ])("preserves parsed semantics and token/comment content: %s", (source) => {
    const formatted = formatCodeModeProgram(source);
    expect(semanticTree(formatted)).toEqual(semanticTree(source));
    // The only allowed source edit is an inserted newline.
    let cursor = 0;
    for (const character of formatted) {
      if (character === source[cursor]) cursor += 1;
      else expect(character).toBe("\n");
    }
    expect(cursor).toBe(source.length);
  });

  it("falls back for malformed, unsupported, or oversized source", () => {
    for (const source of ["const = ;", "const x: number = 1; return x;", "x;".repeat(17000)]) {
      expect(formatCodeModeProgram(source)).toBe(source);
    }
  });

  it("sanitizes and explicitly clips the plain fallback", () => {
    const source = "\u001b[31m" + "x".repeat(CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.maximum + 1);
    expect(formatCodeModeProgram(source)).toBe(
      truncateDisplay(
        stripTerminalControls(source),
        CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.maximum,
      ),
    );
  });
});
