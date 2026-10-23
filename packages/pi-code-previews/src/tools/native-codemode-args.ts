import * as Schema from "effect/Schema";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import {
  decodeUnknownOrUndefined,
  isSensitiveDiagnosticKey,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  codeUnitAt,
} from "pi-cosmic-core";

// Bound once: Pi's loader routes each imported-helper call through an interop proxy.
const codeAt = codeUnitAt;

const Args = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const Scalar = Schema.fromJsonString(Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite]));
const decodeArgs = decodeUnknownOrUndefined(Args);
const decodeScalar = decodeUnknownOrUndefined(Scalar);
const PREVIEW_LENGTH = 200;
const MAX_DEPTH = 16;
const credentialBoundary =
  /\bBearer(?:\s|$)|\b(?:access[_-]?(?:token|key)|refresh[_-]?token|token|api[_-]?key|authorization|password|passwd|secret|private[_-]?key|credentials?)\b["']?\s*(?:[:=]|\s+|$)|\bsk-|[a-z][a-z\d+.-]*:\/\/[^/\s@]+@/iu;

const partialUserinfo = /[a-z][a-z\d+.-]*:\/\/[^/\s@]*:[^/\s@]*$/iu;

function credentialStart(value: string, partial: boolean): number | undefined {
  const ordinary = credentialBoundary.exec(value)?.index;
  const userinfo = partial ? partialUserinfo.exec(value)?.index : undefined;
  if (ordinary === undefined) return userinfo;
  return userinfo === undefined ? ordinary : Math.min(ordinary, userinfo);
}

export function safeNativeArgumentText(value: string, partial = false): string {
  const boundary = credentialStart(value, partial);
  const redacted =
    boundary !== undefined ? `${Fn.pipe(value, Str.slice(0, boundary))}[REDACTED]` : value;
  return sanitizeTerminalLine(sanitizeDiagnosticContent(redacted, { maximumLength: 4096 }));
}

type NativeArgumentScalar = typeof Scalar.Type | string;

export interface NativeArgumentPreview {
  readonly values: Readonly<Record<string, NativeArgumentScalar>>;
  readonly partialFields: ReadonlySet<string>;
  readonly complete: boolean;
  readonly text: string;
}

interface Value {
  readonly complete: boolean;
  readonly scalar?: string | number | boolean | null;
}
interface Redaction {
  readonly start: number;
  readonly end: number;
}

const unfinished = (): Value => ({ complete: false });
const stringEscapes = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

const whitespace = (value: string | undefined) =>
  value === " " || value === "\n" || value === "\r" || value === "\t";

function fieldValue(
  key: string,
  scalar: string | number | boolean | null,
  complete: boolean,
): NativeArgumentScalar {
  if (isSensitiveDiagnosticKey(key)) return "[REDACTED]";
  return Predicate.isString(scalar) ? safeNativeArgumentText(scalar, !complete) : scalar;
}

type EscapeRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "end" }
  | undefined;

class ArgumentParser {
  private cursor = 0;
  readonly fields = new Map<string, NativeArgumentScalar>();
  readonly partialFields = new Set<string>();
  readonly redactions: Redaction[] = [];
  private readonly source: string;
  private readonly truncated: boolean;

  constructor(source: string, truncated: boolean) {
    this.source = source;
    this.truncated = truncated;
  }

  atEnd(): boolean {
    return this.cursor === this.source.length;
  }

  skipWhitespace(): void {
    while (whitespace(this.source[this.cursor])) this.cursor++;
  }

  root(): Value | undefined {
    this.skipWhitespace();
    if (this.source[this.cursor] !== "{") return undefined;
    const root = this.container(0, "}");
    this.skipWhitespace();
    return root;
  }

  private string(isKey = false): Value | undefined {
    const start = this.cursor++;
    let value = "";
    while (this.cursor < this.source.length) {
      const character = this.source[this.cursor++] ?? "";
      if (character === '"') return this.closedString(value, start, isKey);
      if (codeAt(character, 0) < 32) return undefined;
      if (character !== "\\") {
        value += character;
        continue;
      }
      if (this.atEnd()) break;
      const escaped = this.escape();
      if (escaped === undefined) return undefined;
      if (escaped.kind === "end") break;
      value += escaped.text;
    }
    return this.unterminatedString(value, start, isKey);
  }

  private escape(): EscapeRead {
    const escape = this.source[this.cursor++] ?? "";
    if (escape !== "u") {
      const decodedEscape = stringEscapes.get(escape);
      return decodedEscape === undefined ? undefined : { kind: "text", text: decodedEscape };
    }
    const hex = Fn.pipe(this.source, Str.slice(this.cursor, this.cursor + 4));
    if (!/^[0-9a-f]{0,4}$/iu.test(hex)) return undefined;
    if (hex.length < 4) {
      this.cursor = this.source.length;
      return { kind: "end" };
    }
    this.cursor += 4;
    return { kind: "text", text: String.fromCharCode(Number.parseInt(hex, 16)) };
  }

  private closedString(value: string, start: number, isKey: boolean): Value {
    if (!isKey && credentialStart(value, false) !== undefined)
      this.redactions.push({ start, end: this.cursor });
    return { complete: true, scalar: value };
  }

  private unterminatedString(text: string, start: number, isKey: boolean): Value | undefined {
    if (!this.truncated) return undefined;
    const last = codeAt(text, text.length - 1);
    const value = last >= 0xd800 && last <= 0xdbff ? Fn.pipe(text, Str.slice(0, -1)) : text;
    if (!isKey && credentialStart(value, true) !== undefined)
      this.redactions.push({ start, end: this.cursor });
    return { complete: false, scalar: value };
  }

  private objectKey(keys: Set<string>): string | Value | undefined {
    if (this.source[this.cursor] !== '"') return undefined;
    const parsed = this.string(true);
    if (!parsed) return undefined;
    if (!parsed.complete) return unfinished();
    if (!Predicate.isString(parsed.scalar) || keys.has(parsed.scalar)) return undefined;
    keys.add(parsed.scalar);
    this.skipWhitespace();
    if (this.atEnd()) return unfinished();
    if (this.source[this.cursor++] !== ":") return undefined;
    this.skipWhitespace();
    return parsed.scalar;
  }

  private recordField(key: string | undefined, depth: number, start: number, item: Value): void {
    if (key === undefined) return;
    if (isSensitiveDiagnosticKey(key)) this.redactions.push({ start, end: this.cursor });
    if (depth !== 0 || item.scalar === undefined) return;
    this.fields.set(key, fieldValue(key, item.scalar, item.complete));
    if (!item.complete) this.partialFields.add(key);
  }

  private container(depth: number, close: "}" | "]"): Value | undefined {
    this.cursor++;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.cursor] === close) {
      this.cursor++;
      return { complete: true };
    }
    while (this.cursor < this.source.length) {
      let key: string | undefined;
      if (close === "}") {
        const parsedKey = this.objectKey(keys);
        if (!Predicate.isString(parsedKey)) return parsedKey;
        key = parsedKey;
      }
      const start = this.cursor;
      const item = this.parseValue(depth + 1);
      if (!item) return undefined;
      this.recordField(key, depth, start, item);
      if (!item.complete) return unfinished();
      this.skipWhitespace();
      if (this.atEnd()) return unfinished();
      const delimiter = this.source[this.cursor++];
      if (delimiter === close) return { complete: true };
      if (delimiter !== ",") return undefined;
      this.skipWhitespace();
      if (this.source[this.cursor] === close) return undefined;
    }
    return unfinished();
  }

  private parseValue(depth: number): Value | undefined {
    if (depth > MAX_DEPTH) return undefined;
    this.skipWhitespace();
    if (this.atEnd()) return unfinished();
    const character = this.source[this.cursor];
    if (character === '"') return this.string();
    if (character === "{" || character === "[")
      return this.container(depth, character === "{" ? "}" : "]");
    return this.scalar();
  }

  private scalar(): Value | undefined {
    const start = this.cursor;
    while (
      this.cursor < this.source.length &&
      !whitespace(this.source[this.cursor]) &&
      ![",", "}", "]"].includes(this.source[this.cursor] ?? "")
    )
      this.cursor++;
    if (this.atEnd() && this.truncated) {
      const token = Fn.pipe(this.source, Str.slice(start, this.cursor));
      const literal = Arr.some(["true", "false", "null"], (word) =>
        Fn.pipe(word, Str.startsWith(token)),
      );
      const number = /^-$|^-?(?:0|[1-9]\d*)(?:(?:\.\d+)?(?:[eE][+-]?\d*)?|\.\d*)$/u.test(token);
      return literal || number ? unfinished() : undefined;
    }
    const scalar = decodeScalar(Fn.pipe(this.source, Str.slice(start, this.cursor)));
    return scalar === undefined ? undefined : { complete: true, scalar };
  }
}

function mergedRedactions(redactions: readonly Redaction[]): Redaction[] {
  const spans: Redaction[] = [];
  for (const span of Arr.sortWith(redactions, (redaction) => redaction.start, Order.Number)) {
    const previous = spans.at(-1);
    if (previous && span.start <= previous.end)
      spans[spans.length - 1] = { start: previous.start, end: Math.max(previous.end, span.end) };
    else spans.push(span);
  }
  return spans;
}

function redactedText(raw: string, redactions: readonly Redaction[]): string {
  let text = raw;
  for (const span of Arr.reverse(mergedRedactions(redactions)))
    text = `${Fn.pipe(text, Str.slice(0, span.start))}"[REDACTED]"${Fn.pipe(text, Str.slice(span.end))}`;
  return text;
}

export function nativeArgumentPreview(raw: string): NativeArgumentPreview | undefined {
  if (!raw || raw.length > 4096) return undefined;
  const decoded = decodeArgs(raw);
  const truncated =
    decoded === undefined && raw.length === PREVIEW_LENGTH && Fn.pipe(raw, Str.endsWith("..."));
  if (decoded === undefined && !truncated) return undefined;
  const parser = new ArgumentParser(truncated ? Fn.pipe(raw, Str.slice(0, -3)) : raw, truncated);
  const root = parser.root();
  if (!root || !parser.atEnd() || root.complete === truncated) return undefined;
  return {
    values: Rec.fromEntries(parser.fields),
    partialFields: parser.partialFields,
    complete: !truncated,
    text: sanitizeDiagnosticContent(redactedText(raw, parser.redactions), { maximumLength: 4096 }),
  };
}
