import type { Client } from "@modelcontextprotocol/client";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpCapabilities, McpMetadataFamily } from "../client/model.ts";

export interface SdkConnectionState {
  closing: boolean;
  closed: boolean;
  cleanupUnconfirmed: boolean;
  observationCleanupFailed?: boolean;
}

/** Native observer errors cannot replace cleanup evidence or skip finalization. */
export const observeSdkCleanup = (
  observer: ((confirmed: boolean) => void) | undefined,
  confirmed: boolean,
): void => {
  try {
    observer?.(confirmed);
  } catch {
    // This private observer reports evidence only; it owns no resource cleanup.
  }
};

export const sdkCapabilities = (client: Client): Effect.Effect<McpCapabilities, McpBoundaryError> =>
  Effect.try({
    try: () => {
      const capabilities = client.getServerCapabilities();
      return Object.freeze({
        tools: capabilities?.tools !== undefined,
        resources: capabilities?.resources !== undefined,
        prompts: capabilities?.prompts !== undefined,
      });
    },
    catch: () => boundaryError("protocol", "not-sent", "MCP capabilities are unavailable."),
  });

/** Bounded callback ingress. No SDK callback runs an Effect or refreshes metadata. */
export const makeSdkEvents = (client: Client, state: SdkConnectionState) =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<McpMetadataFamily, Cause.Done>({
      capacity: 3,
      strategy: "dropping",
    });
    const terminal = yield* Deferred.make<void, McpBoundaryError>();
    const pending = new Set<McpMetadataFamily>();
    let ended = false;
    const finish = (failure?: McpBoundaryError): void => {
      if (ended) return;
      ended = true;
      Queue.endUnsafe(queue);
      Deferred.doneUnsafe(terminal, failure === undefined ? Effect.void : Effect.fail(failure));
    };
    let observation: "active" | "failed" = "active";
    const observationFailed = (): void => {
      if (ended || state.closing) return;
      observation = "failed";
      state.closing = true;
      finish(boundaryError("transport", "unknown", "MCP metadata observation failed."));
    };
    const changed = (family: McpMetadataFamily): void => {
      if (ended || state.closing || pending.has(family)) return;
      pending.add(family);
      if (!Queue.offerUnsafe(queue, family)) pending.delete(family);
    };
    yield* Effect.try({
      try: () => {
        // Public typed methods select the SDK's exported wire schemas internally.
        client.setNotificationHandler("notifications/tools/list_changed", () => changed("tools"));
        client.setNotificationHandler("notifications/resources/list_changed", () =>
          changed("resources"),
        );
        client.setNotificationHandler("notifications/prompts/list_changed", () =>
          changed("prompts"),
        );
        client.onclose = () => {
          if (state.closing) return;
          state.closing = true;
          state.closed = true;
          finish(boundaryError("transport", "unknown", "MCP connection closed unexpectedly."));
        };
        // SDK onerror also reports individual HTTP failures. It is not terminal evidence.
      },
      catch: () => boundaryError("connection", "not-sent", "Unable to observe MCP connection."),
    });
    return {
      changes: Stream.fromQueue(queue).pipe(
        Stream.map((family) => {
          pending.delete(family);
          return family;
        }),
      ),
      terminal: Deferred.await(terminal),
      health: Effect.sync(() => ({
        closed: state.closing || state.closed,
        cleanupUnconfirmed: state.cleanupUnconfirmed,
        observation,
      })),
      finish,
      observationFailed,
      cleanupFailed: () => {
        state.observationCleanupFailed = true;
        state.cleanupUnconfirmed = true;
        finish(boundaryError("cleanup", "unknown", "MCP observation cleanup failed."));
      },
    };
  });

export type SdkEvents = Effect.Success<ReturnType<typeof makeSdkEvents>>;
