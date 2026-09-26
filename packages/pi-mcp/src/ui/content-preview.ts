/** Pure, display-only copies. No getters, toJSON, links, roles, or content gain authority. */
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { safeTextPrefix, sanitizeDiagnosticContent, stripTerminalControls } from "pi-cosmic-core";
import {
  ownPresentationField as own,
  presentationArrayLength as arrayLength,
} from "../code-mode/presentation-evidence.ts";

export const MCP_DISPLAY_LIMITS = Object.freeze({
  text: 12_000,
  nodes: 256,
  depth: 6,
  lines: 80,
  string: 2_000,
  array: 24,
  object: 24,
  key: 128,
});
type DisplayLimits = { readonly [Key in keyof typeof MCP_DISPLAY_LIMITS]: number };
// A result page is already capped at 50,000 UTF-16 units before this pure display copy.
// Do not inherit card cuts: raw must expose page-sized strings and collections.
const PAGE_DISPLAY_LIMITS: DisplayLimits = {
  text: 50_000,
  lines: 2_000,
  string: 50_000,
  key: 50_000,
  nodes: 50_000,
  array: 25_000,
  object: 25_000,
  depth: 64,
};
export type McpDisplayCut =
  | "strings"
  | "arrays"
  | "objects"
  | "depth"
  | "nodes"
  | "lines"
  | "characters";
export interface McpContentPreview {
  readonly raw: string;
  readonly readable?: string;
  readonly combined: string;
  readonly cuts: readonly McpDisplayCut[];
  readonly readableCuts: readonly McpDisplayCut[];
}

/** Strip controls before redaction, so escape sequences cannot split secret labels. */
export const sanitizeMcpDisplayText = (text: string): string =>
  sanitizeDiagnosticContent(stripTerminalControls(text), { maximumLength: Infinity });

const sensitiveKey = (key: string): boolean =>
  /(?:token|apikey|accesskey|password|passwd|secret|privatekey|credentials?|accountid|teamid|pkce|authorization|authorizationurl|codeverifier|codechallenge|oauthstate|oauthcode|authorizationcode|callbackurl)$/.test(
    stripTerminalControls(key)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ""),
  );

const bound = (
  text: string,
  characters: number,
  lines: number,
  cuts: Set<McpDisplayCut>,
): string => {
  if (text.length > characters) cuts.add("characters");
  // UTF-16 limits match retained cursors, without emitting half a surrogate pair.
  const clipped = safeTextPrefix(text, characters);
  const rows = clipped.split("\n");
  if (rows.length > lines) cuts.add("lines");
  return rows.slice(0, lines).join("\n");
};
const omission = (cuts: ReadonlySet<McpDisplayCut>, page = false): string =>
  cuts.size
    ? `[Display omitted: ${[...cuts].join(", ")}. ${page ? "Stored output is unchanged." : "Use retained output if available."}]`
    : "";

const displayString = (value: string, maximum: number, cuts: Set<McpDisplayCut>): string => {
  if (value.length > maximum) cuts.add("strings");
  const sanitized = sanitizeMcpDisplayText(safeTextPrefix(value, maximum));
  if (sanitized.length > maximum) cuts.add("strings");
  return safeTextPrefix(sanitized, maximum);
};

/** Only exact source content locations qualify, before sanitization can alter keys or types. */
const readableText = <Value>(
  action: string,
  value: Value,
  limits: DisplayLimits,
  cuts: Set<McpDisplayCut>,
): string | undefined => {
  const texts: string[] = [];
  let nodes = 0;
  const text = <Text>(value: Text): void => {
    if (Predicate.isString(value) && value.length)
      texts.push(displayString(value, limits.string, cuts));
  };
  const block = <Block>(value: Block): void => {
    if (own(value, "type").value === "text") text(own(value, "text").value);
    else if (own(value, "type").value === "resource")
      text(own(own(value, "resource").value, "text").value);
  };
  const items = <Items>(value: Items, visit: <Item>(item: Item) => void): void => {
    const length = arrayLength(value) ?? 0;
    if (length > limits.array) cuts.add("arrays");
    for (let index = 0; index < Math.min(length, limits.array); index++) {
      if (++nodes > limits.nodes) {
        cuts.add("nodes");
        break;
      }
      visit(own(value, String(index)).value);
    }
  };
  if (action === "tools.call") items(own(value, "content").value, block);
  else if (action === "resources.read")
    items(own(value, "contents").value, (item) => text(own(item, "text").value));
  else if (action === "prompts.get")
    items(own(value, "messages").value, (message) => {
      const start = texts.length;
      const content = own(message, "content").value;
      if (arrayLength(content) === undefined) block(content);
      else items(content, block);
      const role = own(message, "role").value;
      if (texts.length > start && Predicate.isString(role))
        texts.splice(start, 0, `Message role (data): ${displayString(role, limits.string, cuts)}`);
    });
  return texts.length ? texts.join("\n\n") : undefined;
};

const displayCopy = <Value>(
  value: Value,
  limits: DisplayLimits,
  cuts: Set<McpDisplayCut>,
): Schema.Json => {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const copy = <Current>(current: Current, depth: number): Schema.Json => {
    if (++nodes > limits.nodes) {
      cuts.add("nodes");
      return "[display nodes omitted]";
    }
    if (depth > limits.depth) {
      cuts.add("depth");
      return "[display depth omitted]";
    }
    if (current === null) return null;
    if (Predicate.isString(current)) return displayString(current, limits.string, cuts);
    if (Predicate.isBoolean(current)) return current;
    if (Predicate.isNumber(current)) return Number.isFinite(current) ? current : "[invalid number]";
    if (!Predicate.isObjectOrArray(current)) return "[unavailable]";
    if (seen.has(current)) return "[circular]";
    seen.add(current);
    const length = arrayLength(current);
    if (length !== undefined) {
      const result: Schema.Json[] = [];
      for (let index = 0; index < Math.min(length, limits.array); index++) {
        if (nodes >= limits.nodes) {
          cuts.add("nodes");
          break;
        }
        result.push(copy(own(current, String(index)).value, depth + 1));
      }
      if (length > limits.array) cuts.add("arrays");
      if (result.length < length) result.push(`[${length - result.length} display items omitted]`);
      return result;
    }
    const result: Record<string, Schema.Json> = {};
    try {
      let count = 0;
      for (const key in current) {
        if (++count > limits.object || nodes >= limits.nodes) {
          cuts.add(count > limits.object ? "objects" : "nodes");
          if (!Object.hasOwn(result, "[display fields omitted]"))
            Object.defineProperty(result, "[display fields omitted]", {
              value: true,
              enumerable: true,
            });
          break;
        }
        const field = own(current, key).value;
        if (field === undefined) continue;
        const label = displayString(key, limits.key, cuts);
        if (Object.hasOwn(result, label)) {
          cuts.add("objects");
          continue;
        }
        Object.defineProperty(result, label, {
          value: sensitiveKey(key) ? "[redacted]" : copy(field, depth + 1),
          enumerable: true,
        });
      }
      return result;
    } catch {
      return "[unreadable]";
    }
  };
  return copy(value, 0);
};

/** Raw JSON and recognized text share one character/line budget, including omission evidence. */
export const mcpContentPreview = <Value>(
  action: string,
  value: Value,
  resultEnvelope = false,
): McpContentPreview => {
  const limits = MCP_DISPLAY_LIMITS;
  const cuts = new Set<McpDisplayCut>();
  const readableCuts = new Set<McpDisplayCut>();
  const safe = displayCopy(value, limits, cuts);
  const content = resultEnvelope ? own(value, "result").value : value;
  const readable = readableText(action, content, limits, readableCuts);
  const raw = JSON.stringify(safe, null, 2);
  // Reserve fixed room for the bounded cut categories and headings before splitting the budget.
  const characters = limits.text - 256;
  const lines = limits.lines - 4;
  const rawBounded = bound(
    raw,
    readable ? Math.floor(characters / 2) : characters,
    readable ? Math.floor(lines / 2) : lines,
    cuts,
  );
  const readableBounded =
    readable === undefined
      ? undefined
      : bound(readable, Math.floor(characters / 2), Math.floor(lines / 2), readableCuts);
  for (const cut of readableCuts) cuts.add(cut);
  const note = omission(cuts);
  const combined = [
    ...(readableBounded === undefined ? [] : ["Readable text", readableBounded]),
    "Raw JSON",
    rawBounded,
    ...(note ? [note] : []),
  ].join("\n");
  let preview: McpContentPreview = {
    raw: [rawBounded, ...(note ? [note] : [])].join("\n"),
    combined,
    cuts: [...cuts],
    readableCuts: [...readableCuts],
  };
  if (readableBounded !== undefined)
    preview = { ...preview, readable: [readableBounded, ...(note ? [note] : [])].join("\n") };
  return preview;
};

/** Complete authorized JSON only. Raw preserves the full page allowance, not the card prefix. */
export const mcpPageContentPreview = <Value>(action: string, value: Value) => {
  const cuts = new Set<McpDisplayCut>();
  const readableCuts = new Set<McpDisplayCut>();
  const safe = displayCopy(value, PAGE_DISPLAY_LIMITS, cuts);
  const raw = bound(
    JSON.stringify(safe),
    PAGE_DISPLAY_LIMITS.text - 256,
    PAGE_DISPLAY_LIMITS.lines - 1,
    cuts,
  );
  const text = readableText(action, value, PAGE_DISPLAY_LIMITS, readableCuts);
  const readable =
    text === undefined
      ? undefined
      : bound(text, PAGE_DISPLAY_LIMITS.text - 256, PAGE_DISPLAY_LIMITS.lines - 1, readableCuts);
  for (const cut of readableCuts) cuts.add(cut);
  const note = omission(cuts, true);
  let preview: Omit<McpContentPreview, "combined"> = {
    raw: [raw, ...(note ? [note] : [])].join("\n"),
    cuts: [...cuts],
    readableCuts: [...readableCuts],
  };
  if (readable !== undefined)
    preview = { ...preview, readable: [readable, ...(note ? [note] : [])].join("\n") };
  return preview;
};

/** Partial retained pages stay raw. Sanitization never changes source cursor coordinates. */
export const mcpRawTextPreview = (text: string): string => {
  const cuts = new Set<McpDisplayCut>();
  const sanitized = sanitizeMcpDisplayText(text);
  const bounded = bound(
    sanitized,
    PAGE_DISPLAY_LIMITS.text - 256,
    PAGE_DISPLAY_LIMITS.lines - 1,
    cuts,
  );
  const note = omission(cuts, true);
  return [bounded, ...(note ? [note] : [])].join("\n");
};
