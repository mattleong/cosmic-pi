import { SdkHttpError } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import type { McpProtocolAdapter } from "../contract.ts";

/** Legacy list notifications use the connection's unsolicited channel. */
export const legacyProtocol: McpProtocolAdapter = {
  observe: () => Effect.void,
  isObservationRequest: () => false,
  sessionExpired: (status, headers) => status === 404 && headers.has("mcp-session-id"),
  terminate: (transport) =>
    transport.terminateSession().catch((error) => {
      // Remote absence does not settle any local fetch, body, or SDK owner.
      if (!(error instanceof SdkHttpError) || error.data?.status !== 404) throw error;
    }),
};
