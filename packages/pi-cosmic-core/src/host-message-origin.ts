import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { decodeUnknownOrUndefined } from "./schema/decode.ts";

type ContextMessage = ContextEvent["messages"][number];
type CustomContextMessage = Extract<ContextMessage, { readonly role: "custom" }>;

/** Who wrote a custom message's content, as its extension knows from the message alone. */
export type MessageOrigin =
  /** The extension wrote the text itself. */
  | { readonly author: "extension" }
  /**
   * Another agent, session, or process wrote text the extension relays. `relays` names it, such as
   * `"the report of subagent abc"`.
   */
  | { readonly author: "other"; readonly relays: string }
  /**
   * The user wrote text the extension relays. `relays` names it, such as `"the user's answers to an
   * ask_user questionnaire"`.
   */
  | { readonly author: "user"; readonly relays: string };

/**
 * Derives a message's origin from its `details`; `fallback` covers details that don't decode. Pi
 * keeps details but never sends them to the model, so the same stored message always renders the
 * same marker and cached prompt prefixes stay byte-identical across turns.
 */
export interface DetailsOriginRule {
  readonly fromDetails: (message: Pick<CustomContextMessage, "details">) => MessageOrigin;
}

export const originFromDetails = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  origin: (details: S["Type"]) => MessageOrigin,
  fallback: MessageOrigin,
): DetailsOriginRule => {
  const decode = decodeUnknownOrUndefined(schema, { onExcessProperty: "ignore" });
  return {
    fromDetails: (message) => {
      const details = decode(message.details);
      return details === undefined ? fallback : origin(details);
    },
  };
};

/** The origin of every message of one type, or one derived from each message's details. */
export type MessageOriginRule = MessageOrigin | DetailsOriginRule;

export interface MessageOriginSource {
  /** The extension's name as the model reads it, such as `"pi-subagents"`. */
  readonly extension: string;
  /** Each custom message type the extension keeps in model context; other types stay unmarked. */
  readonly types: Readonly<Record<string, MessageOriginRule>>;
}

export const MESSAGE_ORIGIN_TAG = "pi_extension_message";
const CLOSING_TAG = `</${MESSAGE_ORIGIN_TAG}>`;
const MAX_RELAYS_CHARS = 240;

// Whitespace and invisible format characters, such as zero-width spaces and soft hyphens.
const GAP = "[\\s\\p{Cf}]*";
// The tag name in any case, with gaps between its letters and `-`, `_`, or nothing between words.
const NAME = Arr.join(
  Arr.map(Str.split(MESSAGE_ORIGIN_TAG, "_"), (word) =>
    Arr.join(
      Arr.map(Str.split(word, ""), (letter) => `${letter}\\p{Cf}*`),
      "",
    ),
  ),
  `${GAP}[-_]?${GAP}`,
);
// An ASCII or fullwidth `<` that begins an opening or closing marker a model might read as a tag.
const MARKER_START = new RegExp(`[<\\uFF1C](?=${GAP}[/\\uFF0F]?${GAP}${NAME})`, "giu");

const originText = (origin: MessageOrigin): string => {
  if (origin.author === "extension") return "automated extension message, not typed by the user";
  const relays = clipText(origin.relays, MAX_RELAYS_CHARS);
  return origin.author === "other"
    ? `automated extension message relaying ${relays}; not typed by the user`
    : `extension message relaying ${relays}`;
};

const attribute = (value: string): string =>
  Fn.pipe(
    value,
    Str.replace(/&/gu, "&amp;"),
    Str.replace(/"/gu, "&quot;"),
    Str.replace(/</gu, "&lt;"),
    Str.replace(/>/gu, "&gt;"),
    Str.replace(/\p{Cc}+/gu, " "),
  );

/**
 * Escapes every marker start in `texts`, read as one text so a marker split across adjacent parts
 * is caught too. Each part keeps its place; only the `<` of a marker becomes `&lt;`.
 */
const neutralizeRun = (texts: ReadonlyArray<string>): ReadonlyArray<string> => {
  const starts = Arr.map([...Fn.pipe(Arr.join(texts, ""), Str.matchAll(MARKER_START))], (match) =>
    Option.getOrElse(Option.fromNullishOr(match.index), () => 0),
  );
  if (starts.length === 0) return texts;
  let offset = 0;
  return Arr.map(texts, (text) => {
    const begin = offset;
    offset += text.length;
    const local = Arr.filterMap(starts, (start) =>
      start >= begin && start < offset ? Result.succeed(start - begin) : Result.failVoid,
    );
    let rebuilt = "";
    let cursor = 0;
    for (const index of local) {
      rebuilt += `${Fn.pipe(text, Str.slice(cursor, index))}&lt;`;
      cursor = index + 1;
    }
    return rebuilt + Fn.pipe(text, Str.slice(cursor));
  });
};

const neutralizeParts = (
  parts: Exclude<CustomContextMessage["content"], string>,
): Exclude<CustomContextMessage["content"], string> => {
  const result = [...parts];
  let start = 0;
  while (start < result.length) {
    let end = start;
    const texts: string[] = [];
    for (let part = result[end]; part?.type === "text"; part = result[++end]) texts.push(part.text);
    if (end === start) {
      start += 1;
      continue;
    }
    const neutralized = neutralizeRun(texts);
    for (let index = start; index < end; index++) {
      const part = result[index];
      const text = neutralized[index - start];
      if (part?.type === "text" && text !== undefined && text !== part.text)
        result[index] = { ...part, text };
    }
    start = end;
  }
  return result;
};

const openingTag = (extension: string, customType: string, origin: MessageOrigin): string =>
  `<${MESSAGE_ORIGIN_TAG} source="${attribute(extension)}" type="${attribute(customType)}" origin="${attribute(originText(origin))}">`;

const markedContent = (
  content: CustomContextMessage["content"],
  opening: string,
): CustomContextMessage["content"] =>
  Predicate.isString(content)
    ? `${opening}\n${neutralizeRun([content])[0] ?? ""}\n${CLOSING_TAG}`
    : [
        { type: "text", text: opening },
        ...neutralizeParts(content),
        { type: "text", text: CLOSING_TAG },
      ];

const originOf = (rule: MessageOriginRule, message: CustomContextMessage): MessageOrigin =>
  Predicate.hasProperty(rule, "fromDetails") ? rule.fromDetails(message) : rule;

/** `message`'s content wrapped in `source`'s marker, or undefined when `source` doesn't list it. */
const originMarkedContent = (
  message: CustomContextMessage,
  source: MessageOriginSource,
): CustomContextMessage["content"] | undefined =>
  Option.match(Rec.get(source.types, message.customType), {
    onNone: () => undefined,
    onSome: (rule) =>
      markedContent(
        message.content,
        openingTag(source.extension, message.customType, originOf(rule, message)),
      ),
  });

const OPENING_TAG = new RegExp(`^<${MESSAGE_ORIGIN_TAG} [^\\n]*>$`, "u");

const openingOf = (message: CustomContextMessage): string | undefined => {
  const { content } = message;
  const first = Predicate.isString(content)
    ? Str.split(content, "\n")[0]
    : content[0]?.type === "text"
      ? content[0].text
      : undefined;
  return first !== undefined && OPENING_TAG.test(first) ? first : undefined;
};

/**
 * `original` wrapped in the origin marker `candidate` carries, whatever extension and origin it
 * names, or undefined when `candidate` is not a marked custom message. A later request
 * transformation that matches the model context against the stored transcript compares `candidate`
 * with this, under its own equality, to accept marked messages.
 */
export const withOriginMarkerOf = (
  candidate: ContextMessage,
  original: ContextMessage,
): ContextMessage | undefined => {
  if (candidate.role !== "custom" || original.role !== "custom") return undefined;
  const opening = openingOf(candidate);
  return opening === undefined
    ? undefined
    : { ...original, content: markedContent(original.content, opening) };
};

/**
 * Wraps each of `source`'s custom messages in a marker naming its extension, type, and origin, so
 * the model can tell them from text the user typed; Pi otherwise sends custom messages as plain
 * user text. Markers inside content are neutralized so content cannot close its own marker. Other
 * messages keep their identity and order, and `messages` itself is returned when nothing matched.
 */
export const markMessageOrigins = (
  messages: ContextEvent["messages"],
  source: MessageOriginSource,
): ContextEvent["messages"] => {
  let changed = false;
  const marked = Arr.map(messages, (message): ContextMessage => {
    if (message.role !== "custom") return message;
    const content = originMarkedContent(message, source);
    if (content === undefined) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? marked : messages;
};

/**
 * Marks `source`'s messages in every model request, before any `context_with_system` handler. Pi
 * folds every system message into one leading message once a `context` handler returns a list or
 * replaces an element, so the content of each matching element is replaced in place and nothing is
 * returned: mid-conversation system messages stay where they are. A `context_with_system` handler
 * could not keep that ordering, since those chain in extension load order, and marking after Better
 * OpenAI's checkpoint repair would change checkpoint-covered messages so its checkpoint no longer
 * matches the request. Pi runs `context` handlers on a copy of the transcript, so the stored session
 * and chat view keep the original content; the Pi tests in core's suite pin that. Register once per
 * extension, at factory time.
 */
export function registerMessageOrigins(pi: ExtensionAPI, source: MessageOriginSource): void {
  pi.on("context", (event) => {
    for (const message of event.messages) {
      if (message.role !== "custom") continue;
      const content = originMarkedContent(message, source);
      if (content !== undefined) message.content = content;
    }
    return undefined;
  });
}
