import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import {
  decodeUnknownOrUndefined,
  isSensitiveDiagnosticKey,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
} from "pi-cosmic-core";

const Args = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const Scalar = Schema.fromJsonString(Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite]));
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

/** A cut quoted credential cannot be safely redacted by matching its missing closing quote. */
export function safeNativeArgumentText(value: string, partial = false): string {
  const boundary = credentialStart(value, partial);
  const redacted = boundary !== undefined ? `${value.slice(0, boundary)}[REDACTED]` : value;
  return sanitizeTerminalLine(sanitizeDiagnosticContent(redacted, { maximumLength: 4096 }));
}

type NativeArgumentScalar = typeof Scalar.Type | string;

export interface NativeArgumentPreview {
  readonly values: Readonly<Record<string, NativeArgumentScalar>>;
  readonly partialFields: ReadonlySet<string>;
  readonly complete: boolean;
  /** Original bounded preview with sensitive value spans masked, not repaired JSON. */
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

/**
 * Scan only JSON grammar, including nested containers. A native truncated receipt is a
 * prefix, never repaired into a full argument object. Only observed root scalars survive.
 */
export function nativeArgumentPreview(raw: string): NativeArgumentPreview | undefined {
  if (!raw || raw.length > 4096) return undefined;
  const decoded = decodeUnknownOrUndefined(Args, raw);
  const truncated = decoded === undefined && raw.length === PREVIEW_LENGTH && raw.endsWith("...");
  if (decoded === undefined && !truncated) return undefined;
  const source = truncated ? raw.slice(0, -3) : raw;
  let cursor = 0;
  const fields = new Map<string, NativeArgumentScalar>();
  const partialFields = new Set<string>();
  const redactions: Redaction[] = [];
  const skipWhitespace = () => {
    while (whitespace(source[cursor])) cursor++;
  };
  function string(isKey = false): Value | undefined {
    const start = cursor++;
    let value = "";
    while (cursor < source.length) {
      const character = source[cursor++]!;
      if (character === '"') {
        if (!isKey && credentialStart(value, false) !== undefined)
          redactions.push({ start, end: cursor });
        return { complete: true, scalar: value };
      }
      if (character.charCodeAt(0) < 32) return undefined;
      if (character !== "\\") {
        value += character;
        continue;
      }
      if (cursor === source.length) break;
      const escape = source[cursor++]!;
      if (escape === "u") {
        const hex = source.slice(cursor, cursor + 4);
        if (!/^[0-9a-f]{0,4}$/iu.test(hex)) return undefined;
        if (hex.length < 4) {
          cursor = source.length;
          break;
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 4;
      } else {
        const decodedEscape = stringEscapes.get(escape);
        if (decodedEscape === undefined) return undefined;
        value += decodedEscape;
      }
    }
    if (!truncated) return undefined;
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1);
    if (!isKey && credentialStart(value, true) !== undefined)
      redactions.push({ start, end: cursor });
    return { complete: false, scalar: value };
  }

  /** An object or array; only objects have keys, and only root object fields are retained. */
  function container(depth: number, close: "}" | "]"): Value | undefined {
    cursor++;
    const keys = new Set<string>();
    skipWhitespace();
    if (source[cursor] === close) {
      cursor++;
      return { complete: true };
    }
    while (cursor < source.length) {
      let key: string | undefined;
      if (close === "}") {
        if (source[cursor] !== '"') return undefined;
        const parsed = string(true);
        if (!parsed) return undefined;
        if (!parsed.complete) return unfinished();
        if (!Predicate.isString(parsed.scalar) || keys.has(parsed.scalar)) return undefined;
        key = parsed.scalar;
        keys.add(key);
        skipWhitespace();
        if (cursor === source.length) return unfinished();
        if (source[cursor++] !== ":") return undefined;
        skipWhitespace();
      }
      const start = cursor;
      const item = parseValue(depth + 1);
      if (!item) return undefined;
      if (key !== undefined && isSensitiveDiagnosticKey(key))
        redactions.push({ start, end: cursor });
      if (key !== undefined && depth === 0 && item.scalar !== undefined) {
        fields.set(
          key,
          isSensitiveDiagnosticKey(key)
            ? "[REDACTED]"
            : Predicate.isString(item.scalar)
              ? safeNativeArgumentText(item.scalar, !item.complete)
              : item.scalar,
        );
        if (!item.complete) partialFields.add(key);
      }
      if (!item.complete) return unfinished();
      skipWhitespace();
      if (cursor === source.length) return unfinished();
      const delimiter = source[cursor++];
      if (delimiter === close) return { complete: true };
      if (delimiter !== ",") return undefined;
      skipWhitespace();
      // A trailing comma is not a valid JSON prefix if its closing bracket is present.
      if (source[cursor] === close) return undefined;
    }
    return unfinished();
  }

  function parseValue(depth: number): Value | undefined {
    if (depth > MAX_DEPTH) return undefined;
    skipWhitespace();
    if (cursor === source.length) return unfinished();
    const character = source[cursor];
    if (character === '"') return string();
    if (character === "{" || character === "[")
      return container(depth, character === "{" ? "}" : "]");
    const start = cursor;
    while (
      cursor < source.length &&
      !whitespace(source[cursor]) &&
      ![",", "}", "]"].includes(source[cursor]!)
    )
      cursor++;
    // Without a delimiter, digits may be a prefix of a larger number.
    if (cursor === source.length && truncated) {
      const token = source.slice(start, cursor);
      const literal = ["true", "false", "null"].some((word) => word.startsWith(token));
      const number = /^-$|^-?(?:0|[1-9]\d*)(?:(?:\.\d+)?(?:[eE][+-]?\d*)?|\.\d*)$/u.test(token);
      return literal || number ? unfinished() : undefined;
    }
    const scalar = decodeUnknownOrUndefined(Scalar, source.slice(start, cursor));
    return scalar === undefined ? undefined : { complete: true, scalar };
  }

  skipWhitespace();
  if (source[cursor] !== "{") return undefined;
  const root = container(0, "}");
  skipWhitespace();
  if (!root || cursor !== source.length || root.complete === truncated) return undefined;

  // Merge nested redactions so a sensitive parent value always hides its whole span.
  const spans: Redaction[] = [];
  for (const span of redactions.toSorted((left, right) => left.start - right.start)) {
    const previous = spans.at(-1);
    if (previous && span.start <= previous.end)
      spans[spans.length - 1] = { start: previous.start, end: Math.max(previous.end, span.end) };
    else spans.push(span);
  }
  let text = raw;
  for (const span of spans.toReversed())
    text = `${text.slice(0, span.start)}"[REDACTED]"${text.slice(span.end)}`;
  return {
    values: Object.fromEntries(fields),
    partialFields,
    complete: !truncated,
    text: sanitizeDiagnosticContent(text, { maximumLength: 4096 }),
  };
}
