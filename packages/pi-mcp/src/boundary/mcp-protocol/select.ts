import {
  SUPPORTED_PROTOCOL_VERSIONS,
  SdkHttpError,
  deserializeMessage,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type Client,
  type PriorDiscovery,
  type VersionNegotiationOptions,
  type Transport,
  type RequestId,
  type JSONRPCErrorResponse,
} from "@modelcontextprotocol/client";
import { DiscoverResultSchema } from "@modelcontextprotocol/core";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { boundaryError } from "../../client/errors.ts";
import { legacyProtocol } from "./legacy/adapter.ts";
import { SdkNegotiationRejectedError } from "./shared/negotiation-error.ts";
import { modernProtocol } from "./modern/adapter.ts";
import type { McpProtocolAdapter } from "./contract.ts";

const MODERN_VERSION = "2026-07-28";
// SDK's public SUPPORTED_PROTOCOL_VERSIONS enumerates legacy initialize revisions only.
const supportedVersion = (version: string) =>
  version === MODERN_VERSION || SUPPORTED_PROTOCOL_VERSIONS.includes(version);
const VersionEvidence = Schema.Struct({
  supported: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

const negotiationEvidence = (error: JSONRPCErrorResponse["error"]): boolean => {
  const data = error.data;
  return (
    error.code === -32601 ||
    (error.code === -32022 &&
      Schema.is(VersionEvidence)(data) &&
      data.supported.some(supportedVersion))
  );
};

/** Tighten SDK fallback policy on already decoded, exactly correlated probe replies. */
export const guardNegotiation = (transport: Transport): Transport => {
  let pending: { id: RequestId; accept: () => void; reject: (error: Error) => void } | undefined;
  let closed = false;
  const failure = () => new Error("MCP negotiation response is not safe legacy evidence.");
  const guarded: Transport = {
    get sessionId() {
      return transport.sessionId;
    },
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => transport.setSupportedProtocolVersions?.(versions),
    start: () => transport.start(),
    close: () => {
      closed = true;
      pending?.reject(failure());
      pending = undefined;
      return transport.close();
    },
    send: (message, options) => {
      if (!isJSONRPCRequest(message) || message.method !== "server/discover")
        return transport.send(message, options);
      pending?.reject(failure());
      const checked = Promise.withResolvers<void>();
      pending = { id: message.id, accept: () => checked.resolve(), reject: checked.reject };
      return Promise.all([
        Promise.resolve()
          .then(() => transport.send(message, options))
          .catch((error) => {
            // SDK auto classifies generic 4xx replies as legacy. Require a correlated
            // SDK-decoded negotiation evidence; auth/outage errors stay errors.
            if (
              error instanceof SdkHttpError &&
              error.data.status >= 400 &&
              error.data.status < 500 &&
              error.data.status !== 401 &&
              error.data.status !== 403
            ) {
              let safe = false;
              if (
                (error.data.status === 400 || error.data.status === 404) &&
                Predicate.isString(error.data.text)
              ) {
                try {
                  const reply = deserializeMessage(error.data.text);
                  safe =
                    isJSONRPCErrorResponse(reply) &&
                    reply.id === message.id &&
                    negotiationEvidence(reply.error);
                } catch {
                  /* Malformed error bodies are not negotiation evidence. */
                }
              }
              if (!safe) throw new SdkNegotiationRejectedError();
            }
            throw error;
          }),
        checked.promise,
      ]).then(() => undefined);
    },
  };
  if (transport.hasPerRequestStream)
    Object.defineProperty(guarded, "hasPerRequestStream", { value: true });
  if ("pid" in transport && "stderr" in transport) {
    Object.defineProperties(guarded, {
      pid: { get: () => transport.pid },
      stderr: { get: () => transport.stderr },
    });
  }
  transport.onmessage = (message, extra) => {
    const current = pending;
    if (
      current === undefined ||
      !(isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) ||
      message.id !== current.id
    ) {
      if (!closed) guarded.onmessage?.(message, extra);
      return;
    }
    const accept = () => {
      if (closed || pending !== current) return;
      pending = undefined;
      current.accept();
      guarded.onmessage?.(message, extra);
    };
    const reject = () => {
      if (pending !== current) return;
      pending = undefined;
      current.reject(new SdkNegotiationRejectedError());
    };
    if (isJSONRPCErrorResponse(message)) {
      // Method-not-found is legacy evidence. A typed version disagreement may
      // drive the SDK's bounded corrective negotiation, but generic errors may not.
      if (negotiationEvidence(message.error)) accept();
      else reject();
      return;
    }
    try {
      void Promise.resolve(DiscoverResultSchema["~standard"].validate(message.result)).then(
        (result) => {
          if (result.issues === undefined && result.value.supportedVersions.some(supportedVersion))
            accept();
          else reject();
        },
        reject,
      );
    } catch {
      reject();
    }
  };
  transport.onerror = (error) => guarded.onerror?.(error);
  transport.onclose = () => {
    closed = true;
    pending?.reject(failure());
    pending = undefined;
    guarded.onclose?.();
  };
  return guarded;
};
export const negotiationOptions = (
  protocol: "auto" | "legacy" = "auto",
  probeTimeoutMs?: number,
): VersionNegotiationOptions => ({
  mode: protocol,
  probe:
    probeTimeoutMs === undefined ? { maxRetries: 0 } : { timeoutMs: probeTimeoutMs, maxRetries: 0 },
});

export const selectProtocol = (client: Client) =>
  Effect.try({
    try: (): McpProtocolAdapter => {
      const version = client.getNegotiatedProtocolVersion();
      if (version === MODERN_VERSION) return modernProtocol;
      if (
        version !== undefined &&
        SUPPORTED_PROTOCOL_VERSIONS.includes(version) &&
        version < MODERN_VERSION
      )
        return legacyProtocol;
      throw new Error("Unsupported protocol.");
    },
    catch: () =>
      boundaryError("unsupported", "not-sent", "MCP negotiated an unsupported protocol."),
  });

/** A disposable probe verdict is reused only for the immediately following local child. */
export const priorDiscovery = (client: Client) =>
  Effect.try({
    try: (): PriorDiscovery => {
      const discover = client.getDiscoverResult();
      if (client.getNegotiatedProtocolVersion() === MODERN_VERSION && discover !== undefined)
        return { kind: "modern", discover };
      if (
        client.getNegotiatedProtocolVersion() !== undefined &&
        client.getNegotiatedProtocolVersion()! < MODERN_VERSION
      )
        return { kind: "legacy" };
      throw new Error("Missing negotiation result.");
    },
    catch: () =>
      boundaryError("protocol", "not-sent", "MCP negotiation did not produce a supported result."),
  });
