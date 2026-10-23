import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { codeUnitAt } from "pi-cosmic-core/text-scan";

const ESCAPE = 0x1b;
const BELL = 0x07;
const CANCEL = 0x18;
const SUBSTITUTE = 0x1a;
const C1_CSI = 0x9b;
const C1_STRING_TERMINATOR = 0x9c;
// DCS, SOS, OSC, PM, and APC.
const C1_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const ESCAPE_STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
const MAX_SGR_PARAMETER_CHARS = 128;
// An escape or string sequence still open after this many characters is discarded, so a broken
// sequence cannot swallow the output that follows it.
export const MAX_PENDING_SEQUENCE_CHARS = 4_096;

const SGR_SEQUENCE = new RegExp(String.raw`\u001b\[[0-9;:]*m`, "gu");
// Controls other than newline and tab, including ESC and the C1 range; text mode keeps the rest.
const CONTROL = String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`;
const NEEDS_PARSING = new RegExp(CONTROL, "u");
// Searches from its `lastIndex`, which every use sets first.
const NEXT_CONTROL = new RegExp(CONTROL, "gu");

// Bound once: Pi's loader routes each call through an imported binding via an interop proxy,
// which dominates the per-character sequence parsing below.
const codeAt = codeUnitAt;

type ParserMode = "text" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";

// Digits, colon, and semicolon.
const isSgrParameter = (code: number): boolean => code >= 0x30 && code <= 0x3b;

/**
 * Removes SGR sequences from normalized text. Normalized text contains no other escapes, so the
 * result is the plain text readers and output waits see, independent of neighboring events.
 */
export const plainTerminalText = (text: string): string =>
  Fn.pipe(text, Str.includes("\u001b")) ? Fn.pipe(text, Str.replace(SGR_SEQUENCE, "")) : text;

/**
 * Normalizes one output stream as it arrives. The result holds printable text, newlines, tabs,
 * and complete SGR sequences only; every other control, escape, and string sequence is removed,
 * including sequences split across writes. Carriage returns are removed like other controls.
 */
export class TerminalTextNormalizer {
  private mode: ParserMode = "text";
  private pending = 0;
  private parameters = "";
  private sgr = false;

  write(text: string): string {
    if (this.mode === "text" && !NEEDS_PARSING.test(text)) return text;
    const parts: string[] = [];
    let index = 0;
    while (index < text.length) {
      if (this.mode !== "text") {
        if (!this.consume(codeAt(text, index), parts)) index += 1;
        continue;
      }
      // Kept text runs to the next control, so it is copied without visiting each character.
      NEXT_CONTROL.lastIndex = index;
      const control = NEXT_CONTROL.exec(text)?.index ?? text.length;
      if (control > index) parts.push(Fn.pipe(text, Str.slice(index, control)));
      if (control < text.length) this.introduce(codeAt(text, control));
      index = control + 1;
    }
    return Arr.join(parts, "");
  }

  /** Discards an unfinished sequence, such as one interrupted by lost output. */
  reset(): void {
    this.mode = "text";
    this.pending = 0;
  }

  private enter(mode: ParserMode): void {
    this.mode = mode;
    if (mode === "csi") {
      this.parameters = "";
      this.sgr = true;
    }
  }

  private introduce(code: number): void {
    this.pending = 1;
    if (code === ESCAPE) this.enter("escape");
    else if (code === C1_CSI) this.enter("csi");
    else if (C1_STRING_INTRODUCERS.has(code)) this.enter("string");
  }

  /** Advances an open sequence; returns true when the character must be read again as text. */
  private consume(code: number, parts: string[]): boolean {
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
    if (this.mode === "csi") return this.controlSequence(code, parts);
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
    if (code === 0x5b) this.enter("csi");
    else if (ESCAPE_STRING_INTRODUCERS.has(code)) this.enter("string");
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

  private controlSequence(code: number, parts: string[]): boolean {
    if (code >= 0x40 && code <= 0x7e) {
      if (code === 0x6d && this.sgr) parts.push(`\u001b[${this.parameters}m`);
      this.reset();
      return false;
    }
    if (code >= 0x30 && code <= 0x3f) {
      if (this.sgr && isSgrParameter(code) && this.parameters.length < MAX_SGR_PARAMETER_CHARS)
        this.parameters += String.fromCharCode(code);
      else this.sgr = false;
      return false;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.sgr = false;
      return false;
    }
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
