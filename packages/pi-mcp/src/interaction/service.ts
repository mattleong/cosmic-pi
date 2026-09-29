import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { McpOperation } from "../connection/model.ts";
import type { McpLogLevel, McpProgress } from "../observations/model.ts";
import type { McpInteractionHost } from "./model.ts";
import { converse, type ValidateElicitation } from "./conversation.ts";

export class McpInteraction extends Context.Service<McpInteraction, McpInteractionHost>()(
  "pi-mcp/interaction/service/McpInteraction",
) {
  static readonly layer = (host?: McpInteractionHost) =>
    Layer.succeed(this, host ?? { resolve: Effect.succeed(undefined) });
}

/** Validation still captures the original tool schema; only its terminal request is wrapped. */
export const interactiveOperation = (
  operation: McpOperation,
  host: McpInteractionHost | undefined,
  validate: ValidateElicitation,
  logLevel?: McpLogLevel,
  onProgress?: (progress: McpProgress) => void,
): McpOperation => ({
  ...operation,
  request: (input, options) =>
    Effect.gen(function* () {
      const provider =
        operation.capabilities.multiRoundTrip && host ? yield* host.resolve : undefined;
      yield* operation.checkCurrent;
      let dispatch = options;
      // Logging only observes; a connection without it still runs the request.
      if (logLevel && operation.capabilities.requestLogging) dispatch = { ...dispatch, logLevel };
      if (onProgress) dispatch = { ...dispatch, onprogress: onProgress };
      return yield* converse(operation, input, dispatch, provider, validate);
    }),
});
