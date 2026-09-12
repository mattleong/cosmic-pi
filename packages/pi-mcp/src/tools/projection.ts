import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer, McpResolvedConfig } from "../config/model.ts";
import type { McpConnectionsContract, McpOperation } from "../connection/model.ts";
import type { McpInvocationReply } from "../invocation/validation.ts";
import type { McpPrepareInput, McpResultsContract } from "../results/model.ts";
import type { McpProjectionOptions } from "./model.ts";

interface LocalAuthority {
  readonly config: McpResolvedConfig;
  readonly generation: number;
}

const ownerFor = (revision: number, server: McpEffectiveServer) =>
  `server:${revision}:${server.identity}`;
const globalOwner = (revision: number, generation: number) => `config:${revision}:${generation}`;
const stale = () =>
  boundaryError("stale", "not-sent", "MCP result authority is no longer current.");
export const requireEnabled = (config: McpResolvedConfig) =>
  config.trusted && config.settings.enabled
    ? Effect.void
    : Effect.fail(
        boundaryError("denied", "not-sent", "MCP execution requires an enabled, trusted session."),
      );

export const makeExecutionProjection = (
  connections: McpConnectionsContract,
  results: McpResultsContract,
  revocations: Ref.Ref<number>,
) => {
  const captureLocal = Effect.gen(function* () {
    const config = yield* connections.config;
    return { config, generation: yield* Ref.get(revocations) } satisfies LocalAuthority;
  });

  const authorize = (owner: string, serverId: string): Effect.Effect<void, McpBoundaryError> =>
    Effect.gen(function* () {
      const config = yield* connections.config;
      yield* requireEnabled(config);
      if (serverId === "*") {
        if (owner !== globalOwner(config.revision, yield* Ref.get(revocations)))
          return yield* stale();
      } else {
        const server = yield* connections.requireServer(serverId);
        const current = yield* connections.config;
        yield* requireEnabled(current);
        if (config.revision !== current.revision || owner !== ownerFor(current.revision, server))
          return yield* stale();
      }
    });

  const projectOperation = (
    operation: McpOperation,
    action: string,
    input: Pick<McpPrepareInput, "reply" | "notices" | "outputValidation">,
    options: McpProjectionOptions,
  ) =>
    Effect.gen(function* () {
      const prepared = yield* results.prepare({
        owner: ownerFor(operation.binding.configRevision, operation.server),
        server: operation.server.id,
        action,
        ...input,
      });
      yield* operation.checkCurrent;
      yield* authorize(prepared.owner, prepared.server);
      // Preparation may be expensive. Only the bounded local retention mutation runs
      // in the connection's authority commit, never helper work or remote I/O.
      const retained = yield* operation.commit(results.retain(prepared));
      const execution = yield* results.project(prepared, retained, options);
      yield* operation.checkCurrent;
      yield* authorize(prepared.owner, prepared.server);
      return execution;
    }).pipe(Effect.mapError((error) => boundaryError(error.kind, "completed", error.message)));

  const projectReply = (
    operation: McpOperation,
    input: McpInvocationReply,
    options: McpProjectionOptions,
  ) =>
    projectOperation(
      operation,
      input.reply.action,
      {
        ...input,
        notices: [
          ...(input.notices ?? []),
          ...(input.reply.cleanupUnconfirmed
            ? ["MCP transport cleanup was not confirmed. The completed operation was not replayed."]
            : []),
        ],
      },
      options,
    );

  const projectLocal = (
    action: string,
    data: Schema.Json,
    captured: LocalAuthority,
    options: McpProjectionOptions,
    notices: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      const check = Effect.gen(function* () {
        const current = yield* connections.config;
        if (
          current.revision !== captured.config.revision ||
          current.trusted !== captured.config.trusted ||
          (yield* Ref.get(revocations)) !== captured.generation
        )
          return yield* stale();
        if (action !== "status") yield* requireEnabled(current);
      });
      yield* check;
      const prepared = yield* results.prepare({
        owner: globalOwner(captured.config.revision, captured.generation),
        server: "*",
        action,
        reply: { outcome: "completed", result: data },
        notices,
      });
      yield* check;
      const retention =
        captured.config.trusted && captured.config.settings.enabled
          ? yield* results.retain(prepared)
          : { status: "unretained" as const, reason: "unavailable" as const };
      const execution = yield* results.project(prepared, retention, options);
      yield* check;
      return execution;
    });

  return { captureLocal, projectOperation, projectReply, projectLocal, authorize };
};
