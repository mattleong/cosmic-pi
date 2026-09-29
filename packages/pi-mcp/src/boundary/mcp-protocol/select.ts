import type {
  Client,
  PriorDiscovery,
  VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { boundaryError } from "../../client/errors.ts";
import { legacyProtocol } from "./legacy/adapter.ts";
import { modernProtocol } from "./modern/adapter.ts";
import type { McpProtocolAdapter } from "./contract.ts";

/**
 * Omission probes the modern era first. The SDK classifies probe replies: authorization
 * failures, server errors, network failures, and HTTP timeouts stay errors, and other
 * evidence falls back to legacy initialization.
 */
export const negotiationOptions = (
  protocol: "auto" | "legacy" = "auto",
  probeTimeoutMs?: number,
  pin?: string,
): VersionNegotiationOptions => ({
  // A pinned revision negotiates in place and fails loudly instead of falling back.
  mode: pin === undefined ? protocol : { pin },
  probe:
    probeTimeoutMs === undefined ? { maxRetries: 0 } : { timeoutMs: probeTimeoutMs, maxRetries: 0 },
});

/** The SDK's negotiated era selects the adapter; no version string is compared here. */
export const selectProtocol = (client: Client) =>
  Effect.try({
    try: (): McpProtocolAdapter => {
      const era = client.getProtocolEra();
      if (era === "modern") return modernProtocol;
      if (era === "legacy") return legacyProtocol;
      throw new Error("Unsupported protocol.");
    },
    catch: () =>
      boundaryError("unsupported", "not-sent", "MCP negotiated an unsupported protocol."),
  });

/** A disposable probe verdict is reused only for the immediately following local child. */
export const priorDiscovery = (client: Client) =>
  Effect.try({
    try: (): PriorDiscovery => {
      const era = client.getProtocolEra();
      const discover = client.getDiscoverResult();
      if (era === "modern" && discover !== undefined) return { kind: "modern", discover };
      if (era === "legacy") return { kind: "legacy" };
      throw new Error("Missing negotiation result.");
    },
    catch: () =>
      boundaryError("protocol", "not-sent", "MCP negotiation did not produce a supported result."),
  });
