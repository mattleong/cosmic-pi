// Delegated-Pi to packaged supervisor MCP helper process boundary.
// Wire frames are encoded here because this boundary owns the JSON-RPC dialect.
import { nodePath } from "./node-builtins.ts";
import { fileURLToPath } from "node:url";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  MAX_SUPERVISOR_MCP_PROXY_JSON_CHARS,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_PROXY_TOOL_NAME,
  type SupervisorMcpToolArgumentsByName,
} from "../supervisor/mcp-contract.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";
import {
  makeNdjsonRpcSession,
  type InboundClassification,
  type NdjsonRpcSession,
  RpcCallRejectedError,
  type RpcSessionError,
  RpcSessionTransportError,
} from "./rpc-session.ts";

type SupervisorMcpToolName = keyof SupervisorMcpToolArgumentsByName;

const MAX_LINE_BYTES = 3 * 1024 * 1024;
const MAX_BRIDGE_TEXT_CHARS = MAX_SUPERVISOR_MCP_PROXY_JSON_CHARS + 128;
const MAX_PENDING = 16;
const WRITE_QUEUE_CAPACITY = 32;
const CALL_TIMEOUT_MILLIS = 15_000;
const QUESTION_TIMEOUT_MILLIS = 10 * 60_000;
const PROXY_TIMEOUT_MILLIS = 60 * 60_000;
const INITIALIZE_REQUEST_ID = "pi-bridge-initialize";
const packagedHelperPath = fileURLToPath(new URL("./supervisor-mcp-helper.mjs", import.meta.url));

interface BridgeInitializeRequest {
  readonly jsonrpc: "2.0";
  readonly id: typeof INITIALIZE_REQUEST_ID;
  readonly method: "initialize";
  readonly params: {
    readonly protocolVersion: "2025-06-18";
    readonly capabilities: object;
    readonly clientInfo: { readonly name: "pi-subagents-pi-bridge"; readonly version: "1.0.0" };
  };
}

interface BridgeInitializedNotification {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/initialized";
  readonly params: object;
}

interface BridgeToolCallRequest<Name extends SupervisorMcpToolName = SupervisorMcpToolName> {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "tools/call";
  readonly params: {
    readonly name: Name;
    readonly arguments: SupervisorMcpToolArgumentsByName[Name];
  };
}

type BridgeOutboundMessage =
  | BridgeInitializeRequest
  | BridgeInitializedNotification
  | BridgeToolCallRequest;

const BridgeNotification = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  method: Schema.Literal("notifications/pi_subagents"),
  params: Schema.Struct({
    updateId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32 * 1024)),
  }),
});
const BridgeResponseDiscriminant = Schema.Struct({ id: Schema.optional(Schema.Unknown) });
const BridgeResponse = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number.check(Schema.isFinite(), Schema.isInt()),
      message: Schema.String.check(Schema.isMaxLength(64 * 1024)),
      data: Schema.optional(Schema.Unknown),
    }),
  ),
});
const BridgeInitializeResult = Schema.Struct({
  protocolVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  capabilities: Schema.Struct({ tools: Schema.Struct({ listChanged: Schema.Boolean }) }),
  serverInfo: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
});
const BridgeTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.check(Schema.isMaxLength(MAX_BRIDGE_TEXT_CHARS)),
});
const BridgeToolResult = Schema.Struct({
  content: Schema.Array(BridgeTextContent),
  isError: Schema.optional(Schema.Boolean),
});

type BridgeReply =
  | {
      readonly kind: "initialized";
      readonly result: Schema.Schema.Type<typeof BridgeInitializeResult>;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "notification"; readonly message: string };

const decodeBridgeNotificationOption = Schema.decodeUnknownOption(BridgeNotification);
const decodeBridgeResponseDiscriminantOption = Schema.decodeUnknownOption(
  BridgeResponseDiscriminant,
);
const decodeBridgeResponseOption = Schema.decodeUnknownOption(BridgeResponse);
const decodeBridgeInitializeResultOption = Schema.decodeUnknownOption(BridgeInitializeResult);
const decodeBridgeToolResultOption = Schema.decodeUnknownOption(BridgeToolResult);

const classifyBridgeLine = (line: string): InboundClassification<BridgeReply> => {
  const parsed = decodeUnknownJsonOption(line);
  if (Option.isNone(parsed))
    return { kind: "protocol-error", reason: "Private supervisor bridge returned malformed JSON." };
  const value = parsed.value;
  const notification = decodeBridgeNotificationOption(value);
  if (Option.isSome(notification))
    return {
      kind: "event",
      value: { kind: "notification", message: notification.value.params.message },
    };
  const discriminant = decodeBridgeResponseDiscriminantOption(value);
  if (Option.isNone(discriminant)) {
    return {
      kind: "protocol-error",
      reason: "Private supervisor bridge returned an invalid response.",
    };
  }
  const rawId = discriminant.value.id;
  const id = Predicate.isString(rawId) ? rawId : undefined;
  if (!id) return { kind: "ignore" };
  const response = decodeBridgeResponseOption(value);
  if (Option.isNone(response)) {
    return {
      kind: "rejection",
      id,
      detail: "Private supervisor helper returned an invalid response.",
    };
  }
  if (response.value.error) {
    return { kind: "rejection", id, detail: "Private supervisor helper rejected the request." };
  }
  if (id === INITIALIZE_REQUEST_ID) {
    const result = decodeBridgeInitializeResultOption(response.value.result);
    if (Option.isNone(result)) {
      return {
        kind: "rejection",
        id,
        detail: "Private supervisor helper returned an invalid result.",
      };
    }
    return { kind: "reply", id, value: { kind: "initialized", result: result.value } };
  }
  const result = decodeBridgeToolResultOption(response.value.result);
  const text = Option.isSome(result) ? result.value.content[0]?.text : undefined;
  if (Option.isNone(result) || result.value.isError === true || text === undefined) {
    return {
      kind: "rejection",
      id,
      detail: text ?? "Private supervisor helper rejected the call.",
    };
  }
  return { kind: "reply", id, value: { kind: "text", text } };
};

export interface PiSupervisorBridgeClient {
  readonly call: <Name extends SupervisorMcpToolName>(
    name: Name,
    input: SupervisorMcpToolArgumentsByName[Name],
  ) => Effect.Effect<string, RpcSessionError>;
}

export interface PiSupervisorBridgeOpenOptions {
  /** Package-test seam only; production always uses the packaged helper. */
  readonly helperPath?: string | undefined;
  readonly initializeTimeoutMillis?: number | undefined;
  readonly onNotification?: ((message: string) => void) | undefined;
}

const initializeRequest = (): BridgeInitializeRequest => ({
  jsonrpc: "2.0",
  id: INITIALIZE_REQUEST_ID,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-subagents-pi-bridge", version: "1.0.0" },
  },
});

const toolCallRequest = <Name extends SupervisorMcpToolName>(
  id: string,
  name: Name,
  input: SupervisorMcpToolArgumentsByName[Name],
): BridgeToolCallRequest<Name> => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: input },
});

type OpenBridgeSession = NdjsonRpcSession<BridgeReply>;

// Locally constructed JSON-RPC frames are serialized by this pure dialect encoder.
const encodeFrame = (message: BridgeOutboundMessage): string => `${JSON.stringify(message)}\n`;

const initializedNotificationFrame = (): string =>
  encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

const makeBridgeClientDoor = (session: OpenBridgeSession): PiSupervisorBridgeClient => {
  let nextId = 0;
  return {
    call: <Name extends SupervisorMcpToolName>(
      name: Name,
      input: SupervisorMcpToolArgumentsByName[Name],
    ): Effect.Effect<string, RpcSessionError> =>
      Effect.suspend(() => {
        const requestId = `pi-bridge-${++nextId}`;
        const timeoutMillis =
          name === SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[2]
            ? QUESTION_TIMEOUT_MILLIS
            : name === SUPERVISOR_MCP_PROXY_TOOL_NAME
              ? PROXY_TIMEOUT_MILLIS
              : CALL_TIMEOUT_MILLIS;
        return session
          .call(requestId, encodeFrame(toolCallRequest(requestId, name, input)), timeoutMillis)
          .pipe(
            Effect.flatMap((reply) =>
              reply.kind === "text"
                ? Effect.succeed(reply.text)
                : Effect.fail(
                    new RpcCallRejectedError({
                      detail: "Private supervisor call returned its initialize payload.",
                    }),
                  ),
            ),
          );
      }),
  };
};

/** Opens one initialized bridge session bound to the caller's Scope. */
export const openPiSupervisorBridge = (
  configPath: string,
  options: PiSupervisorBridgeOpenOptions = {},
): Effect.Effect<PiSupervisorBridgeClient, RpcSessionError, Scope.Scope> =>
  Effect.gen(function* () {
    if (
      !nodePath.isAbsolute(configPath) ||
      configPath.length < 1 ||
      configPath.length > 4_096 ||
      configPath.includes("\0") ||
      configPath.includes("\r") ||
      configPath.includes("\n")
    ) {
      return yield* new RpcSessionTransportError({
        message: "Private supervisor configuration path is invalid.",
      });
    }
    const parentScope = yield* Effect.scope;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const openingScope = yield* Scope.fork(parentScope);
        return yield* restore(
          Effect.gen(function* () {
            const session = yield* makeNdjsonRpcSession<BridgeReply>({
              command: process.execPath,
              args: [options.helperPath ?? packagedHelperPath, "--config", configPath],
              environment: {},
              diagnosticMaxBytes: 0,
              waitForSpawnEvent: false,
              maxLineBytes: MAX_LINE_BYTES,
              maxQueuedOutputBytes: MAX_LINE_BYTES * 2,
              maxPendingCalls: MAX_PENDING,
              writeQueueCapacity: WRITE_QUEUE_CAPACITY,
              classifyInbound: classifyBridgeLine,
              onEvent: (event) => {
                if (event.kind === "notification") options.onNotification?.(event.message);
              },
              unknownReplyPolicy: "ignore",
              cancelNotification: (id) =>
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/cancelled",
                  params: { requestId: id, reason: "Pi tool call cancelled" },
                })}\n`,
            });
            yield* session
              .call(
                INITIALIZE_REQUEST_ID,
                encodeFrame(initializeRequest()),
                options.initializeTimeoutMillis ?? CALL_TIMEOUT_MILLIS,
              )
              .pipe(
                Effect.filterOrFail(
                  (reply) => reply.kind === "initialized",
                  () =>
                    new RpcCallRejectedError({
                      detail:
                        "Private supervisor bridge initialization returned an unexpected payload.",
                    }),
                ),
              );
            yield* session.notify(initializedNotificationFrame());

            return makeBridgeClientDoor(session);
          }).pipe(Effect.provideService(Scope.Scope, openingScope)),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(openingScope, exit) : Effect.void,
          ),
        );
      }),
    );
  });
