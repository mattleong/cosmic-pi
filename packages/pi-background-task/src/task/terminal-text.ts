import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { codeUnitAt } from "pi-cosmic-core/text-scan";

const ESCAPE = 0x1b;
const BELL = 0x07;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const CANCEL = 0x18;
const SUBSTITUTE = 0x1a;
const C1_CSI = 0x9b;
const C1_STRING_TERMINATOR = 0x9c;
// DCS, SOS, OSC, PM, and APC.
const C1_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const ESCAPE_STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
// An escape or string sequence still open after this many characters is discarded, so a broken
// sequence cannot swallow the output that follows it.
export const MAX_PENDING_SEQUENCE_CHARS = 4_096;

// Controls other than newline and tab, including ESC and the C1 range; text mode keeps the rest.
const CONTROL = String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`;
const NEEDS_PARSING = new RegExp(CONTROL, "u");
// Searches from its `lastIndex`, which every use sets first.
const NEXT_CONTROL = new RegExp(CONTROL, "gu");

// Bound once: Pi's loader routes each call through an imported binding via an interop proxy,
// which dominates the per-character sequence parsing below.
const codeAt = codeUnitAt;

type ParserMode = "text" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";
// Where the stored text ends: at a line start, at a line start a carriage return made, or mid-line.
type LinePosition = "start" | "carriage" | "middle";

/**
 * Normalizes one output stream as it arrives into plain text: printable text, newlines, and tabs
 * only. Every other control, escape, and string sequence, colors included, is removed, including
 * sequences split across writes.
 *
 * A carriage return that ends text becomes a line break, so progress redrawn in place reads as
 * one line per update. A line feed right after it, even in the next write, belongs to the same
 * break, and a carriage return at a line start adds none.
 */
export class TerminalTextNormalizer {
  private mode: ParserMode = "text";
  private pending = 0;
  private line: LinePosition = "start";

  write(text: string): string {
    if (this.mode === "text" && !NEEDS_PARSING.test(text)) return this.kept(text);
    const parts: string[] = [];
    let index = 0;
    while (index < text.length) {
      if (this.mode !== "text") {
        if (!this.consume(codeAt(text, index))) index += 1;
        continue;
      }
      // Kept text runs to the next control, so it is copied without visiting each character.
      NEXT_CONTROL.lastIndex = index;
      const control = NEXT_CONTROL.exec(text)?.index ?? text.length;
      if (control > index) parts.push(this.kept(Fn.pipe(text, Str.slice(index, control))));
      if (control < text.length) {
        const code = codeAt(text, control);
        if (code === CARRIAGE_RETURN) this.carriageReturn(parts);
        else this.introduce(code);
      }
      index = control + 1;
    }
    return Arr.join(parts, "");
  }

  /** Text as stored: a line feed that completes a carriage return's break is already written. */
  private kept(text: string): string {
    const completesBreak = this.line === "carriage" && codeAt(text, 0) === NEWLINE;
    if (completesBreak) this.line = "start";
    const kept = completesBreak ? Fn.pipe(text, Str.slice(1)) : text;
    if (kept) this.line = codeAt(kept, kept.length - 1) === NEWLINE ? "start" : "middle";
    return kept;
  }

  private carriageReturn(parts: string[]): void {
    if (this.line !== "middle") return;
    parts.push("\n");
    this.line = "carriage";
  }

  /**
   * Starts fresh after lost output: an unfinished sequence is discarded, and a line feed that
   * follows is a line break of its own rather than the end of an earlier carriage return's.
   */
  outputLost(): void {
    this.reset();
    if (this.line === "carriage") this.line = "start";
  }

  private reset(): void {
    this.mode = "text";
    this.pending = 0;
  }

  private introduce(code: number): void {
    this.pending = 1;
    if (code === ESCAPE) this.mode = "escape";
    else if (code === C1_CSI) this.mode = "csi";
    else if (C1_STRING_INTRODUCERS.has(code)) this.mode = "string";
  }

  /** Advances an open sequence; returns true when the character must be read again as text. */
  private consume(code: number): boolean {
    this.pending += 1;
    if (this.pending > MAX_PENDING_SEQUENCE_CHARS) {
      this.reset();
      return true;
    }
    if (code === CANCEL || code === SUBSTITUTE) {
      this.reset();
      return false;
    }
    if (this.mode === "escape") return this.escape(code);
    if (this.mode === "escape-intermediate") return this.escapeIntermediate(code);
    if (this.mode === "csi") return this.controlSequence(code);
    if (this.mode === "string") {
      if (code === BELL || code === C1_STRING_TERMINATOR) this.reset();
      else if (code === ESCAPE) this.mode = "string-escape";
      return false;
    }
    if (this.mode === "string-escape" && code === 0x5c) {
      this.reset();
      return false;
    }
    // Any other escape inside a string ends the string and starts a new sequence.
    this.pending = 1;
    this.mode = "escape";
    return true;
  }

  private escape(code: number): boolean {
    if (code === 0x5b) this.mode = "csi";
    else if (ESCAPE_STRING_INTRODUCERS.has(code)) this.mode = "string";
    else if (code === ESCAPE) this.pending = 1;
    else if (code >= 0x20 && code <= 0x2f) this.mode = "escape-intermediate";
    else {
      this.reset();
      return code < 0x30 || code > 0x7e;
    }
    return false;
  }

  private escapeIntermediate(code: number): boolean {
    if (code >= 0x20 && code <= 0x2f) return false;
    if (code === ESCAPE) {
      this.pending = 1;
      this.mode = "escape";
      return false;
    }
    this.reset();
    return code < 0x30 || code > 0x7e;
  }

  private controlSequence(code: number): boolean {
    if (code >= 0x40 && code <= 0x7e) {
      this.reset();
      return false;
    }
    // Parameter and intermediate characters.
    if (code >= 0x20 && code <= 0x3f) return false;
    if (code === ESCAPE) {
      this.pending = 1;
      this.mode = "escape";
      return false;
    }
    // A control or non-ASCII character cannot continue the sequence; read it as text.
    this.reset();
    return true;
  }
}
