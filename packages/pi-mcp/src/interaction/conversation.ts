import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { FormOutcome } from "pi-ask-user/protocol";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpDispatchOptions, McpReply, McpRequest } from "../client/model.ts";
import type { McpOperation } from "../connection/model.ts";
import { mcpCodeModeJsonFits } from "../code-mode/protocol.ts";
import { prepareElicitation } from "./form.ts";
import {
  MCP_INTERACTION_LIMITS,
  type McpContinuation,
  type McpInteractionProvider,
} from "./model.ts";

export type ValidateElicitation = (
  schema: Schema.Json,
  data: Schema.Json,
) => Effect.Effect<void, McpBoundaryError>;

/** The originating ticket owns the whole flow deadline. No permit is held while asking. */
export const converse = (
  operation: McpOperation,
  input: McpRequest,
  options: McpDispatchOptions | undefined,
  provider: McpInteractionProvider | undefined,
  validate: ValidateElicitation,
): Effect.Effect<McpReply, McpBoundaryError> =>
  Effect.suspend(() => {
    let continued = false;
    return Effect.gen(function* () {
      if (
        !operation.exchange ||
        !operation.capabilities.multiRoundTrip ||
        (input.action !== "tools.call" &&
          input.action !== "resources.read" &&
          input.action !== "prompts.get")
      )
        return yield* operation.request(input, options);
      let continuation: McpContinuation | undefined;
      let requested = 0;
      let declined = false;
      const check = Effect.gen(function* () {
        yield* operation.checkContinuation ?? operation.checkCurrent;
        if (provider && !(yield* provider.current))
          return yield* boundaryError(
            "stale",
            continued ? "unknown" : "not-sent",
            "MCP input provider authority changed.",
          );
      });
      for (let round = 0; round < MCP_INTERACTION_LIMITS.rounds; round++) {
        yield* check;
        let dispatch: McpDispatchOptions = { ...options };
        if (provider) dispatch = { ...dispatch, elicitation: true };
        if (continuation !== undefined) dispatch = { ...dispatch, continuation };
        const exchange = yield* operation.exchange(input, dispatch);
        if (exchange.kind === "complete") return exchange.reply;
        continued = true;
        if (exchange.cleanupUnconfirmed)
          return yield* boundaryError(
            "cleanup",
            "unknown",
            "MCP input request cleanup is unconfirmed.",
          );
        if (round + 1 === MCP_INTERACTION_LIMITS.rounds)
          return yield* boundaryError(
            "unsupported",
            "unknown",
            "MCP conversation round limit reached.",
          );
        if (declined)
          return yield* boundaryError(
            "cancelled",
            "unknown",
            "MCP requested more input after the user declined.",
          );
        const requests = Object.entries(exchange.inputRequests ?? {});
        requested += requests.length;
        if (
          requested > MCP_INTERACTION_LIMITS.requests ||
          !mcpCodeModeJsonFits(exchange.inputRequests ?? {}, MCP_INTERACTION_LIMITS.bytes)
        )
          return yield* boundaryError("unsupported", "unknown", "MCP input request limit reached.");
        // Reject the entire batch before answering any member, including unsupported methods.
        const prepared = yield* Effect.forEach(requests, ([id, value]) =>
          prepareElicitation(value).pipe(Effect.map((elicitation) => ({ id, ...elicitation }))),
        );
        if (prepared.length > 0 && !provider)
          return yield* boundaryError(
            "unsupported",
            "unknown",
            "MCP input requires an available owned user interface.",
          );
        const responses: Record<string, FormOutcome> = {};
        for (const [index, item] of prepared.entries()) {
          yield* check;
          // A decline applies to the whole batch. Remaining requests receive cancel, not another UI.
          if (declined) {
            Object.defineProperty(responses, item.id, {
              value: { action: "cancel" },
              enumerable: true,
            });
            continue;
          }
          const owner = {
            extensionId: "pi-mcp",
            operationId: operation.operationId ?? operation.owner,
            requestId: `${round}:${index}`,
            label: `MCP ${operation.server.id}`,
          };
          let answer = yield* provider!.ask(item.request, owner);
          yield* check;
          if (answer.action === "accept" && item.request.kind === "url") {
            const opened = yield* provider!.openBrowser(item.request.url, check);
            yield* check;
            answer = opened ? { action: "accept" } : { action: "cancel" };
            if (opened) {
              // No polling or server notification can resume this flow. The user resumes once.
              answer = yield* provider!.ask(
                {
                  kind: "form",
                  message: "Continue after finishing in your browser, or cancel.",
                  fields: [],
                },
                { ...owner, requestId: `${round}:resume:${index}` },
              );
              yield* check;
              if (answer.action === "accept") answer = { action: "accept" };
            }
          }
          if (answer.action === "accept" && item.schema !== undefined) {
            const content = answer.content ?? {};
            yield* validate(item.schema, content);
            yield* check;
            answer = { action: "accept", content };
          }
          if (answer.action !== "accept") declined = true;
          Object.defineProperty(responses, item.id, { value: answer, enumerable: true });
        }
        if (!mcpCodeModeJsonFits(responses, MCP_INTERACTION_LIMITS.bytes))
          return yield* boundaryError(
            "invalid-input",
            "unknown",
            "MCP input responses exceeded their limit.",
          );
        // Absent state clears the previous round's state. Never parse, retain, or expose it.
        continuation = requests.length ? { inputResponses: responses } : {};
        if (exchange.requestState !== undefined)
          continuation = { ...continuation, requestState: exchange.requestState };
      }
      return yield* boundaryError(
        "unsupported",
        "unknown",
        "MCP conversation round limit reached.",
      );
    }).pipe(
      Effect.mapError((error) =>
        continued && error.outcome === "not-sent"
          ? boundaryError(error.kind, "unknown", error.message, error.reason)
          : error,
      ),
    );
  });
