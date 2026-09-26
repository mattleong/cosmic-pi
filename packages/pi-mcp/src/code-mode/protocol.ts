import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  decodeUnknownOrUndefined,
  makeSessionCapabilityProtocol,
  type SessionCapabilityQuery,
} from "pi-cosmic-core";
import { McpBoundaryError } from "../client/errors.ts";
import { McpDataRequestSchema, McpGatewayReplySchema } from "../tools/model.ts";
import { ownPresentationField } from "./presentation-evidence.ts";
import { mcpRequestGuidance } from "../tools/request-guidance.ts";

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

const RequestAction = Schema.Union(
  McpDataRequestSchema.members.map((member) => member.fields.action),
);

/** A detached rejection, never a raw SDK error or an Effect runtime failure. */
export class McpCodeModeError extends Schema.TaggedError<McpCodeModeError>()("McpCodeModeError", {
  kind: McpBoundaryError.fields.kind,
  outcome: McpBoundaryError.fields.outcome,
  message: Schema.String.check(Schema.isMaxLength(512)),
  requestAction: Schema.optionalKey(RequestAction),
}) {}

const FailureMetadata = Schema.Struct({
  _tag: Schema.Literals(["McpCodeModeError", "McpBoundaryError"]),
  kind: McpBoundaryError.fields.kind,
  outcome: McpBoundaryError.fields.outcome,
});
const failureMessages = {
  unavailable: "MCP is not active for this trusted session.",
  "invalid-input":
    "MCP request is invalid or contains unsupported fields. Use a supported data action and only its declared fields.",
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
  requestAction?: McpCodeModeInput["action"],
): McpCodeModeError => {
  const action =
    kind === "invalid-input" && outcome === "not-sent"
      ? decodeUnknownOrUndefined(RequestAction, requestAction)
      : undefined;
  if (action === undefined)
    return new McpCodeModeError({ kind, outcome, message: failureMessages[kind] });
  return new McpCodeModeError({
    kind,
    outcome,
    message: mcpRequestGuidance(action),
    requestAction: action,
  });
};

const decodeOwnField = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
  key: string,
): S["Type"] | undefined =>
  decodeUnknownOrUndefined(schema, ownPresentationField(value, key).value);

/** Capture only an admitted, recognized action; never read request accessors or rejected values. */
export const mcpCodeModeInputError = <Value>(input: Value): McpCodeModeError =>
  mcpCodeModeError(
    "invalid-input",
    "not-sent",
    mcpCodeModeJsonFits(input, MCP_CODE_MODE_MAX_INPUT_BYTES)
      ? decodeOwnField(RequestAction, input, "action")
      : undefined,
  );

/** Preserve checked certainty and action, never a rejection's message, cause, or accessors. */
export const normalizeMcpCodeModeError = <Value>(value: Value): McpCodeModeError => {
  const decoded = decodeUnknownOrUndefined(FailureMetadata, {
    _tag: decodeOwnField(FailureMetadata.fields._tag, value, "_tag"),
    kind: decodeOwnField(FailureMetadata.fields.kind, value, "kind"),
    outcome: decodeOwnField(FailureMetadata.fields.outcome, value, "outcome"),
  });
  return decoded
    ? mcpCodeModeError(
        decoded.kind,
        decoded.outcome,
        decodeOwnField(RequestAction, value, "requestAction"),
      )
    : mcpCodeModeError("transport", "unknown");
};

const OutcomeSchema = Schema.Struct({ outcome: McpBoundaryError.fields.outcome });
/** Projection failure must not relabel a known completed operation as not-sent. */
export const mcpCodeModeOutcome = <Value>(value: Value): McpCodeModeOutput["outcome"] =>
  decodeUnknownOrUndefined(OutcomeSchema, value)?.outcome ?? "unknown";

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

const codeModeProtocol = makeSessionCapabilityProtocol({
  version: MCP_CODE_MODE_VERSION,
  maxSessionIdChars: 1024,
});

export type McpCodeModeQuery = SessionCapabilityQuery<typeof MCP_CODE_MODE_VERSION>;

export const normalizeMcpCodeModeQuery = codeModeProtocol.normalizeQuery;

export const normalizeMcpCodeModeCapability = <Value>(
  value: Value,
): McpCodeModeCapability | undefined => {
  const decoded = codeModeProtocol.decodeCapability(value);
  if (!decoded) return undefined;
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
    const keys = Reflect.ownKeys(item);
    if (keys.length > 100_000) return false;
    for (const key of keys) {
      if (array && key === "length") continue;
      if (!Predicate.isString(key)) return false;
      count += 1;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
      const child: unknown = descriptor.value;
      if (count > 1 && !spend(1)) return false;
      if (array) {
        if (key !== String(count - 1)) return false;
      } else if (!string(key) || !spend(1)) return false;
      if (!visit(child, depth + 1)) return false;
    }
    ancestors.delete(item);
    return !array || count === decodeOwnField(Schema.Natural, item, "length");
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
};

/** Native MCP binary envelopes are not JSON attachment descriptors.
 * Only a checked tools.describe reply can carry schema literals at data.result's roots.
 * Retained result.read pages stay strings; embedded action/origin fields grant no exemption.
 */
export const mcpCodeModeHasBinary = (
  value: McpCodeModeOutput["data"],
  action?: McpCodeModeOutput["action"],
): boolean => {
  const visit = (item: McpCodeModeOutput["data"], context?: "data" | "description"): boolean => {
    if (
      item === null ||
      Predicate.isString(item) ||
      Predicate.isNumber(item) ||
      Predicate.isBoolean(item)
    )
      return false;
    if (Array.isArray(item)) return item.some((child) => visit(child));
    if (
      ("blob" in item && Predicate.isString(item.blob)) ||
      ("base64" in item && Predicate.isString(item.base64))
    )
      return true;
    if (
      "type" in item &&
      (item.type === "image" || item.type === "audio") &&
      "data" in item &&
      Predicate.isString(item.data)
    )
      return true;
    return Object.entries(item).some(([key, child]) => {
      if (context === "description" && (key === "inputSchema" || key === "outputSchema"))
        return false;
      return visit(
        child,
        context === "data" && key === "result" && action === "tools.describe"
          ? "description"
          : undefined,
      );
    });
  };
  return visit(value, "data");
};
