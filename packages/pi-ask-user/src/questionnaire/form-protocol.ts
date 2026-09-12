import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { QuestionnaireEvents } from "./protocol.ts";

export const OWNED_FORM_CAPABILITY_QUERY = "pi-ask-user:owned-form-capability-query:v1";
export const MAX_FORM_BYTES = 65_536;
const text = Schema.String.check(Schema.isMaxLength(4096));
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(4096));
const number = Schema.Finite;
const options = Schema.Array(Schema.Struct({ value: text, title: Schema.optionalKey(text) })).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
const common = {
  key: id,
  title: Schema.optionalKey(text),
  description: Schema.optionalKey(text),
  required: Schema.optionalKey(Schema.Boolean),
};
export const FormFieldSchema = Schema.Union([
  Schema.Struct({
    ...common,
    type: Schema.Literal("string"),
    default: Schema.optionalKey(text),
    minLength: Schema.optionalKey(count),
    maxLength: Schema.optionalKey(count),
    format: Schema.optionalKey(Schema.Literals(["email", "uri", "date", "date-time"])),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literals(["number", "integer"]),
    default: Schema.optionalKey(number),
    minimum: Schema.optionalKey(number),
    maximum: Schema.optionalKey(number),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("boolean"),
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("enum"),
    options,
    default: Schema.optionalKey(text),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("multi-enum"),
    options,
    default: Schema.optionalKey(Schema.Array(text).check(Schema.isMaxLength(64))),
    minItems: Schema.optionalKey(count),
    maxItems: Schema.optionalKey(count),
  }),
]);
export type FormField = typeof FormFieldSchema.Type;
export const ExtensionFormOwnerSchema = Schema.Struct({
  extensionId: id,
  operationId: id,
  requestId: id,
  label: id,
});
export type ExtensionFormOwner = typeof ExtensionFormOwnerSchema.Type;
export const OwnedFormRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("form"),
    message: text,
    fields: Schema.Array(FormFieldSchema).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    message: text,
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  }),
]);
export type OwnedFormRequest = typeof OwnedFormRequestSchema.Type;
export const FormValueSchema = Schema.Union([
  text,
  number,
  Schema.Boolean,
  Schema.Array(text).check(Schema.isMaxLength(64)),
]);
export type FormValue = typeof FormValueSchema.Type;
export const FormOutcomeSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("accept"),
    content: Schema.optionalKey(Schema.Record(text, FormValueSchema)),
  }),
  Schema.Struct({ action: Schema.Literals(["decline", "cancel"]) }),
]);
export type FormOutcome = typeof FormOutcomeSchema.Type;

/** Local-extension capability, not an authenticated subagent relay or registered tool.
 * Answers return only to this caller. They are never steered, persisted, or copied to the transcript.
 * URL acceptance is consent to open the displayed URL in a browser, NOT navigation.
 * Ask User never opens or fetches URLs. The caller must recheck authority before navigation.
 */
export interface OwnedFormCapability {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: string;
  readonly ask: (
    request: OwnedFormRequest,
    owner: ExtensionFormOwner,
    signal: AbortSignal,
  ) => Promise<FormOutcome>;
  /** Revoke this exact call synchronously and join its owned presentation cleanup. */
  readonly cancel: (owner: ExtensionFormOwner) => Promise<void>;
}

// Snapshot plain bounded data without invoking accessors or toJSON. Remote schemas,
// callbacks and executable validators never cross this local presentation protocol.
type FormData =
  | string
  | number
  | boolean
  | readonly FormData[]
  | { readonly [key: string]: FormData };
function capture<Input>(input: Input): FormData {
  let nodes = 0;
  let bytes = 0;
  const visit = <Value>(value: Value, depth: number): FormData => {
    if (++nodes > 8192 || depth > 6) throw new Error("Bound exceeded");
    if (Predicate.isString(value)) {
      if (value.length > 8192) throw new Error("Bound exceeded");
      bytes += new TextEncoder().encode(value).length;
      if (bytes > MAX_FORM_BYTES) throw new Error("Bound exceeded");
      return value;
    }
    if (Predicate.isBoolean(value) || (Predicate.isNumber(value) && Number.isFinite(value)))
      return value;
    if (!Predicate.isObjectOrArray(value)) throw new Error("Invalid data");
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Predicate.isNumber(length) || !Number.isInteger(length) || length < 0 || length > 64)
        throw new Error("Bound exceeded");
      return Array.from({ length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !("value" in property)) throw new Error("Invalid data");
        return visit(property.value, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid data");
    const keys = Object.keys(value);
    if (keys.length > 16) throw new Error("Bound exceeded");
    const entries = keys.map((key) => {
      visit(key, depth + 1);
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property)) throw new Error("Invalid data");
      return [key, visit(property.value, depth + 1)] as const;
    });
    return Object.fromEntries(entries);
  };
  const snapshot = visit(input, 0);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_FORM_BYTES)
    throw new Error("Bound exceeded");
  return snapshot;
}
export function decodeOwnedFormRequest<Input>(input: Input): OwnedFormRequest | undefined {
  try {
    return Schema.decodeUnknownSync(OwnedFormRequestSchema)(capture(input));
  } catch {
    return undefined;
  }
}
export function decodeFormOutcome<Input>(input: Input): FormOutcome | undefined {
  try {
    return Schema.decodeUnknownSync(FormOutcomeSchema)(capture(input));
  } catch {
    return undefined;
  }
}
export function decodeExtensionFormOwner<Input>(input: Input): ExtensionFormOwner | undefined {
  try {
    return Schema.decodeUnknownSync(ExtensionFormOwnerSchema)(capture(input));
  } catch {
    return undefined;
  }
}
export function queryOwnedFormCapability(
  events: QuestionnaireEvents,
  sessionId: string,
): OwnedFormCapability | undefined {
  let found: OwnedFormCapability | undefined;
  let accepting = true;
  let failed = false;
  let responses = 0;
  try {
    events.emit(OWNED_FORM_CAPABILITY_QUERY, {
      version: 1,
      sessionId,
      respond: (value: OwnedFormCapability) => {
        if (!accepting) return;
        try {
          const version = value?.version;
          const candidateSession = value?.sessionId;
          const generation = value?.generation;
          const ask = value?.ask;
          const cancel = value?.cancel;
          if (
            version === 1 &&
            candidateSession === sessionId &&
            Predicate.isString(generation) &&
            generation.length > 0 &&
            Predicate.isFunction(ask) &&
            Predicate.isFunction(cancel)
          ) {
            responses++;
            found = Object.freeze({
              version,
              sessionId: candidateSession,
              generation,
              ask,
              cancel,
            });
          }
        } catch {
          failed = true;
        }
      },
    });
  } catch {
    failed = true;
  }
  accepting = false;
  // Duplicate responses are ambiguous even when they repeat the same object.
  return !failed && responses === 1 ? found : undefined;
}
