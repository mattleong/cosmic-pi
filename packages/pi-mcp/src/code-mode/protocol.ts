import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpBoundaryError } from "../client/errors.ts";
import { McpDataRequestSchema, McpGatewayReplySchema } from "../tools/model.ts";

export const MCP_CODE_MODE_VERSION = 1 as const;
export const MCP_CODE_MODE_QUERY = "pi-mcp:v1:code-mode:query";
export const MCP_CODE_MODE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MCP_CODE_MODE_MAX_INPUT_BYTES = 1024 * 1024;

/** These codecs share the gateway contract, but reject fields outside the selected action. */
export const McpCodeModeInputSchema = McpDataRequestSchema.annotate({
  parseOptions: { onExcessProperty: "error" },
});
export const McpCodeModeOutputSchema = McpGatewayReplySchema.annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type McpCodeModeInput = typeof McpCodeModeInputSchema.Type;
export type McpCodeModeOutput = typeof McpCodeModeOutputSchema.Type;

/** A detached rejection, never a raw SDK error or an Effect runtime failure. */
export class McpCodeModeError extends Schema.TaggedError<McpCodeModeError>()("McpCodeModeError", {
  kind: McpBoundaryError.fields.kind,
  outcome: McpBoundaryError.fields.outcome,
  message: Schema.String.check(Schema.isMaxLength(512)),
}) {}

const FailureMetadata = Schema.Struct({
  _tag: Schema.Literals(["McpCodeModeError", "McpBoundaryError"]),
  kind: McpBoundaryError.fields.kind,
  outcome: McpBoundaryError.fields.outcome,
});
const failureMessages = {
  unavailable: "MCP is not active for this trusted session.",
  "invalid-input": "MCP request is invalid or contains unsupported fields.",
  connection: "MCP connection failed.",
  transport: "MCP transport failed. Do not replay a possibly dispatched operation.",
  protocol: "MCP returned an unrecognized result shape.",
  "output-limit":
    "MCP output exceeds the child-output allowance. Read a narrower retained result if available; do not repeat the original operation.",
  cancelled: "MCP request was cancelled. Remote work may have continued.",
  timeout: "MCP request timed out. Remote work may have continued.",
  cleanup: "MCP cleanup is unconfirmed. Replacement admission is unavailable.",
  "auth-required": "MCP requires authentication through an explicit user /mcp command.",
  denied: "MCP request is not permitted by the current server policy.",
  "not-found": "MCP server, operation, or retained result was not found.",
  stale: "MCP session, configuration, metadata, or retained result is no longer current.",
  busy: "MCP admission is full.",
  config: "MCP configuration is unavailable or invalid.",
  unsupported: "MCP operation or capability is unsupported.",
} satisfies Readonly<Record<McpCodeModeError["kind"], string>>;

export const mcpCodeModeError = (
  kind: McpCodeModeError["kind"],
  outcome: McpCodeModeError["outcome"],
): McpCodeModeError => new McpCodeModeError({ kind, outcome, message: failureMessages[kind] });

const decodeSafely = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
  } catch {
    return undefined;
  }
};

/** Preserve checked certainty, never an unknown rejection's message, cause, or coercion. */
export const normalizeMcpCodeModeError = <Value>(value: Value): McpCodeModeError => {
  const decoded = decodeSafely(FailureMetadata, value);
  return decoded
    ? mcpCodeModeError(decoded.kind, decoded.outcome)
    : mcpCodeModeError("transport", "unknown");
};

const OutcomeSchema = Schema.Struct({ outcome: McpBoundaryError.fields.outcome });
/** Projection failure must not relabel a known completed operation as not-sent. */
export const mcpCodeModeOutcome = <Value>(value: Value): McpCodeModeOutput["outcome"] =>
  decodeSafely(OutcomeSchema, value)?.outcome ?? "unknown";

export interface McpCodeModeCapability {
  readonly version: typeof MCP_CODE_MODE_VERSION;
  readonly sessionId: string;
  readonly execute: (
    callId: string,
    input: McpCodeModeInput,
    signal: AbortSignal,
    maxOutputBytes: number,
  ) => Promise<McpCodeModeOutput>;
}

export interface McpCodeModeQuery {
  readonly version: typeof MCP_CODE_MODE_VERSION;
  readonly sessionId: string;
  readonly respond: <Candidate>(candidate: Candidate) => void;
}

const SessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const QuerySchema = Schema.Struct({
  version: Schema.Literal(MCP_CODE_MODE_VERSION),
  sessionId: SessionId,
  respond: Schema.Unknown,
});
const CapabilitySchema = Schema.Struct({
  version: Schema.Literal(MCP_CODE_MODE_VERSION),
  sessionId: SessionId,
  execute: Schema.Unknown,
});

const containThenable = <Value>(value: Value): void => {
  try {
    if (!Predicate.isObjectOrArray(value) && !Predicate.isFunction(value)) return;
    // SAFETY: Only inspect the optional then field after narrowing to an object or function.
    const then = (value as { readonly then?: unknown }).then;
    if (Predicate.isFunction(then))
      then.call(
        value,
        () => undefined,
        () => undefined,
      );
  } catch {
    // Response callbacks cannot escape this synchronous event boundary.
  }
};

export const normalizeMcpCodeModeQuery = <Value>(value: Value): McpCodeModeQuery | undefined => {
  const decoded = decodeSafely(QuerySchema, value);
  if (!decoded || !Predicate.isFunction(decoded.respond)) return undefined;
  const respond = decoded.respond;
  return Object.freeze({
    version: decoded.version,
    sessionId: decoded.sessionId,
    respond: <Candidate>(candidate: Candidate): void => {
      try {
        const outcome: unknown = respond(candidate);
        containThenable(outcome);
      } catch {
        // Response callbacks cannot escape this synchronous event boundary.
      }
    },
  });
};

export const normalizeMcpCodeModeCapability = <Value>(
  value: Value,
): McpCodeModeCapability | undefined => {
  const decoded = decodeSafely(CapabilitySchema, value);
  if (!decoded || !Predicate.isFunction(decoded.execute)) return undefined;
  const execute = decoded.execute;
  return Object.freeze({
    version: decoded.version,
    sessionId: decoded.sessionId,
    execute: (
      callId: string,
      input: McpCodeModeInput,
      signal: AbortSignal,
      maxOutputBytes: number,
    ) => execute(callId, input, signal, maxOutputBytes),
  });
};

/** Exact compact-JSON size admission before schema decoding or allocating a serialized copy. */
export const mcpCodeModeJsonFits = <Value>(value: Value, maxBytes: number): boolean => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return false;
  let remaining = Math.min(maxBytes, MCP_CODE_MODE_MAX_OUTPUT_BYTES);
  let nodes = 0;
  const ancestors = new Set<object>();
  const spend = (bytes: number): boolean => (remaining -= bytes) >= 0;
  const string = (text: string): boolean => {
    if (text.length > remaining || !spend(2)) return false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      ) {
        if (!spend(2)) return false;
      } else if (code < 32) {
        if (!spend(6)) return false;
      } else if (code < 128) {
        if (!spend(1)) return false;
      } else if (code < 2048) {
        if (!spend(2)) return false;
      } else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      ) {
        if (!spend(4)) return false;
        index += 1;
      } else if (!spend(code >= 0xd800 && code <= 0xdfff ? 6 : 3)) return false;
    }
    return true;
  };
  const visit = <Item>(item: Item, depth: number): boolean => {
    if (++nodes > 100_000 || depth > 64) return false;
    if (item === null) return spend(4);
    if (Predicate.isString(item)) return string(item);
    if (Predicate.isBoolean(item)) return spend(item ? 4 : 5);
    if (Predicate.isNumber(item)) return Number.isFinite(item) && spend(String(item).length);
    if (!Predicate.isObjectOrArray(item) || ancestors.has(item)) return false;
    if (Object.getOwnPropertyDescriptor(item, "toJSON") !== undefined) return false;
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null)
      return false;
    ancestors.add(item);
    if (!spend(2)) return false;
    let count = 0;
    for (const key in item) {
      if (++count > 100_000 || !Object.hasOwn(item, key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) return false;
      const child: unknown = descriptor.value;
      if (count > 1 && !spend(1)) return false;
      if (array) {
        if (key !== String(count - 1)) return false;
      } else if (!string(key) || !spend(1)) return false;
      if (!visit(child, depth + 1)) return false;
    }
    ancestors.delete(item);
    return !array || count === item.length;
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
};

/** Native MCP binary envelopes are not JSON attachment descriptors. */
export const mcpCodeModeHasBinary = (value: McpCodeModeOutput["data"]): boolean => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  )
    return false;
  if (Array.isArray(value)) return value.some(mcpCodeModeHasBinary);
  if (
    ("blob" in value && Predicate.isString(value.blob)) ||
    ("base64" in value && Predicate.isString(value.base64))
  )
    return true;
  if (
    "type" in value &&
    (value.type === "image" || value.type === "audio") &&
    "data" in value &&
    Predicate.isString(value.data)
  )
    return true;
  return Object.values(value).some(mcpCodeModeHasBinary);
};
