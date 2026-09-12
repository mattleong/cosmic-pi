import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FormFieldSchema, type FormField, type OwnedFormRequest } from "pi-ask-user/protocol";
import { boundaryError } from "../client/errors.ts";
import { mcpCodeModeJsonFits } from "../code-mode/protocol.ts";

const Text = Schema.String.check(Schema.isMaxLength(4_096));
const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Titled = Schema.Struct({ const: Text, title: Schema.optionalKey(Text) });
const Choices = Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(64));
const TitledChoices = Schema.Array(Titled).check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(4_096));
const Property = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean", "array"]),
  title: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  default: Schema.optionalKey(Schema.Json),
  minLength: Schema.optionalKey(Count),
  maxLength: Schema.optionalKey(Count),
  format: Schema.optionalKey(Schema.Literals(["email", "uri", "date", "date-time"])),
  minimum: Schema.optionalKey(Schema.Finite),
  maximum: Schema.optionalKey(Schema.Finite),
  enum: Schema.optionalKey(Choices),
  oneOf: Schema.optionalKey(TitledChoices),
  minItems: Schema.optionalKey(Count),
  maxItems: Schema.optionalKey(Count),
  items: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.Literal("string")),
      enum: Schema.optionalKey(Choices),
      anyOf: Schema.optionalKey(TitledChoices),
    }),
  ),
});
const Root = Schema.Struct({
  type: Schema.Literal("object"),
  properties: Schema.Record(Key, Property),
  required: Schema.optionalKey(Schema.Array(Key).check(Schema.isMaxLength(16))),
  additionalProperties: Schema.optionalKey(Schema.Literal(false)),
  title: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  $schema: Schema.optionalKey(Text),
});
const Form = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literal("form")),
  message: Text,
  requestedSchema: Schema.Json,
});
const Url = Schema.Struct({
  mode: Schema.Literal("url"),
  message: Text,
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  elicitationId: Schema.optionalKey(Key),
});
const Request = Schema.Struct({
  method: Schema.Literal("elicitation/create"),
  params: Schema.Union([Form, Url]),
});
const secret =
  /password|passphrase|secret|api[\s_-]*key|(?:access|refresh|auth)[\s_-]*token|private[\s_-]*key|credit[\s_-]*card|card[\s_-]*(?:number|security)|\bcvv\b|\bcvc\b|one.time.password/i;
const unsupported = () =>
  boundaryError(
    "unsupported",
    "unknown",
    "MCP input uses an unsupported or sensitive form schema.",
  );

/** Secure external navigation only; the original URL is never fetched or normalized for echo. */
export const safeElicitationUrl = (value: string): boolean => {
  try {
    if (
      [...value].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};
export interface PreparedElicitation {
  readonly request: OwnedFormRequest;
  readonly schema?: Schema.Json;
}

/** Translate a bounded flat schema before any UI call. No schema compilation runs here. */
export const prepareElicitation = <Value>(
  value: Value,
): Effect.Effect<PreparedElicitation, import("../client/errors.ts").McpBoundaryError> =>
  Effect.gen(function* () {
    if (!mcpCodeModeJsonFits(value, 65_536)) return yield* unsupported();
    const input = yield* Schema.decodeUnknownEffect(Request)(value, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(unsupported));
    const params = input.params;
    if (params.mode === "url") {
      if (!safeElicitationUrl(params.url)) return yield* unsupported();
      return { request: { kind: "url", message: params.message, url: params.url } };
    }
    const root = yield* Schema.decodeUnknownEffect(Root)(params.requestedSchema, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(unsupported));
    const properties = Object.entries(root.properties);
    if (
      properties.length > 16 ||
      root.required?.some((key) => !Object.hasOwn(root.properties, key)) ||
      secret.test(`${params.message} ${root.title ?? ""} ${root.description ?? ""}`)
    )
      return yield* unsupported();
    const fields: FormField[] = [];
    let enumValues = 0;
    for (const [key, property] of properties) {
      if (secret.test(`${key} ${property.title ?? ""} ${property.description ?? ""}`))
        return yield* unsupported();
      const { type, items, enum: values, oneOf, ...rest } = property;
      let field: Schema.JsonObject;
      const common = { key, required: root.required?.includes(key) ?? false, ...rest };
      if (type === "array") {
        if (
          !items ||
          values ||
          oneOf ||
          (!items.enum && !items.anyOf) ||
          (items.enum && items.anyOf)
        )
          return yield* unsupported();
        const options = items.enum
          ? items.enum.map((value) => ({ value }))
          : items.anyOf!.map((choice) =>
              choice.title ? { value: choice.const, title: choice.title } : { value: choice.const },
            );
        enumValues += options.length;
        field = { ...common, type: "multi-enum", options };
      } else if (type === "string" && (values || oneOf)) {
        if (items || (values && oneOf)) return yield* unsupported();
        const options = values
          ? values.map((value) => ({ value }))
          : oneOf!.map((choice) =>
              choice.title ? { value: choice.const, title: choice.title } : { value: choice.const },
            );
        enumValues += options.length;
        field = { ...common, type: "enum", options };
      } else {
        if (items || values || oneOf) return yield* unsupported();
        field = { ...common, type };
      }
      if (enumValues > 64) return yield* unsupported();
      fields.push(
        yield* Schema.decodeUnknownEffect(FormFieldSchema)(field, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(unsupported)),
      );
    }
    return {
      request: { kind: "form", message: params.message, fields },
      schema: params.requestedSchema,
    };
  });
