import * as Effect from "effect/Effect";
import type { McpProtocolAdapter } from "../contract.ts";
import { ownSubscription } from "./subscriptions.ts";

export const modernProtocol: McpProtocolAdapter = {
  observe: (client, events, timeout, cleanupTimeout) =>
    Effect.suspend(() => {
      const capabilities = client.getServerCapabilities();
      const filter = {
        toolsListChanged: capabilities?.tools?.listChanged === true,
        resourcesListChanged: capabilities?.resources?.listChanged === true,
        promptsListChanged: capabilities?.prompts?.listChanged === true,
      };
      return !Object.values(filter).some(Boolean)
        ? Effect.void
        : ownSubscription(client, filter, events, timeout, cleanupTimeout);
    }),
  isObservationRequest: (method) => method === "subscriptions/listen",
  sessionExpired: () => false,
  // Stateless modern HTTP has no legacy session to delete.
  terminate: () => Promise.resolve(),
};
