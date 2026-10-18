import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type JsonPrefixScalar = string | boolean;

const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

interface Container {
  readonly kind: "object" | "array";
  key: string;
  index: number;
}

type Expectation = "value" | "element-or-end" | "key" | "key-or-end" | "separator";

/**
 * Reads the string and boolean leaves that a truncated JSON document exposes before it was cut,
 * keyed by dotted path such as `message.content.0.tool_use_id`. Scanning stops at the first
 * incomplete or invalid token, so a leaf is reported only when its whole value is present.
 */
export const jsonPrefixScalars = (text: string): ReadonlyMap<string, JsonPrefixScalar> => {
  const scalars = new Map<string, JsonPrefixScalar>();
  const containers: Container[] = [];
  let position = 0;
  const take = (pattern: RegExp): string | undefined => {
    const sticky = new RegExp(pattern.source, "y");
    sticky.lastIndex = position;
    const match = sticky.exec(text)?.[0];
    if (match !== undefined) position = sticky.lastIndex;
    return match;
  };
  const takeString = (): Option.Option<string> => {
    const literal = take(/"(?:[^"\\]|\\.)*"/);
    return literal === undefined ? Option.none() : decodeJsonString(literal);
  };
  const path = () =>
    containers.map((entry) => (entry.kind === "object" ? entry.key : `${entry.index}`)).join(".");
  const open = (kind: Container["kind"]): Expectation => {
    position += 1;
    containers.push({ kind, key: "", index: 0 });
    return kind === "object" ? "key-or-end" : "element-or-end";
  };
  const close = (): Expectation => {
    position += 1;
    containers.pop();
    return "separator";
  };
  const separator = (container: Container | undefined): Expectation | undefined => {
    const next = text[position];
    if (!container) return undefined;
    if (next === (container.kind === "object" ? "}" : "]")) return close();
    if (next !== ",") return undefined;
    position += 1;
    container.index += 1;
    return container.kind === "object" ? "key" : "value";
  };
  const key = (container: Container | undefined): Expectation | undefined => {
    const name = takeString();
    take(/[ \t\r\n]*/);
    if (Option.isNone(name) || !container || text[position] !== ":") return undefined;
    position += 1;
    container.key = name.value;
    return "value";
  };
  const value = (): Expectation | undefined => {
    const next = text[position];
    if (next === "{") return open("object");
    if (next === "[") return open("array");
    if (next === '"') {
      const string = takeString();
      if (Option.isNone(string)) return undefined;
      scalars.set(path(), string.value);
      return "separator";
    }
    const literal = take(/true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (literal === undefined) return undefined;
    if (literal === "true" || literal === "false") scalars.set(path(), literal === "true");
    return "separator";
  };
  const step = (expectation: Expectation): Expectation | undefined => {
    take(/[ \t\r\n]*/);
    const container = containers.at(-1);
    switch (expectation) {
      case "separator":
        return separator(container);
      case "key-or-end":
        return text[position] === "}" ? close() : key(container);
      case "key":
        return key(container);
      case "element-or-end":
        return text[position] === "]" ? close() : value();
      case "value":
        return value();
    }
    return undefined;
  };

  for (let expectation = step("value"); expectation; expectation = step(expectation));
  return scalars;
};
