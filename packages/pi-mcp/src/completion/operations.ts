import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";
import type { McpOperation } from "../connection/model.ts";
import type { McpDiscoveryContract } from "../discovery/model.ts";
import type { McpGatewayRequest } from "../tools/model.ts";

const Result = Schema.Struct({
  completion: Schema.Struct({
    values: Schema.Array(Schema.String.check(Schema.isMaxLength(8_192))).check(
      Schema.isMaxLength(100),
    ),
    total: Schema.optionalKey(Schema.Natural),
    hasMore: Schema.optionalKey(Schema.Boolean),
  }),
});

/** Complete exact advertised references only. URI templates are never fetched locally. */
export const completeArgument = (
  operation: McpOperation,
  input: Extract<McpGatewayRequest, { readonly action: "completion.complete" }>,
  discovery: McpDiscoveryContract,
) =>
  Effect.gen(function* () {
    yield* operation.checkCurrent;
    if (!operation.capabilities.completions)
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "MCP server does not advertise completions.",
      );
    const snapshot = yield* discovery.ensure(operation);
    yield* operation.checkCurrent;
    const ref = input.ref;
    let names: ReadonlySet<string> | undefined;
    if (ref.type === "ref/prompt") {
      const prompt = snapshot.prompts.find((candidate) => candidate.name === ref.name);
      if (!prompt)
        return yield* boundaryError(
          "not-found",
          "not-sent",
          "MCP completion prompt was not advertised.",
        );
      names = new Set((prompt.arguments ?? []).map((argument) => argument.name));
    } else {
      const template = snapshot.templates.find((candidate) => candidate.uriTemplate === ref.uri);
      if (!template)
        return yield* boundaryError(
          "not-found",
          "not-sent",
          "MCP completion template was not advertised.",
        );
      // RFC 6570 variable names, with operator and explode/prefix modifiers removed.
      names = new Set(
        [...template.uriTemplate.matchAll(/\{[+#./;?&]?([^{}]+)\}/g)].flatMap((match) =>
          match[1]!.split(",").map((name) => name.replace(/(?:\*|:\d+)$/, "")),
        ),
      );
    }
    if (
      names &&
      (!names.has(input.argument.name) ||
        Object.keys(input.context?.arguments ?? {}).some((name) => !names.has(name)))
    )
      return yield* boundaryError(
        "invalid-input",
        "not-sent",
        "MCP completion argument was not advertised.",
      );
    yield* operation.checkCurrent;
    const request = { action: "completion.complete" as const, ref, argument: input.argument };
    const reply = yield* operation.request(
      input.context ? { ...request, context: input.context } : request,
    );
    const result = yield* Schema.decodeUnknownEffect(Result)(reply.result).pipe(
      Effect.mapError(() =>
        boundaryError(
          "protocol",
          "completed",
          "MCP completion exceeded its bounds or was invalid.",
        ),
      ),
    );
    yield* operation.checkCurrent;
    return { ...reply, result };
  });
