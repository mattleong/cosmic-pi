import type { Client, PriorDiscovery, Transport } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { boundaryError, type McpBoundaryError } from "../../../client/errors.ts";
import { priorDiscovery, guardNegotiation } from "../select.ts";

export interface OwnedStdioProbe {
  readonly client: Client;
  readonly transport: Transport;
  readonly close: Effect.Effect<void, McpBoundaryError>;
}

/** Probe only on a disposable owned child; never reinterpret a failed connect as legacy. */
export const negotiateStdio = (
  acquire: Effect.Effect<OwnedStdioProbe, McpBoundaryError, Scope.Scope>,
  remaining: Effect.Effect<number, McpBoundaryError>,
): Effect.Effect<PriorDiscovery, McpBoundaryError> =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const probe = yield* acquire;
        const result = yield* Effect.exit(
          restore(
            remaining.pipe(
              Effect.flatMap((timeoutMs) =>
                Effect.tryPromise({
                  try: (signal) =>
                    probe.client.connect(guardNegotiation(probe.transport), {
                      signal,
                      timeout: timeoutMs,
                      maxTotalTimeout: timeoutMs,
                    }),
                  catch: () =>
                    boundaryError(
                      "connection",
                      "not-sent",
                      "MCP stdio negotiation failed. Known legacy servers may require protocol: legacy.",
                    ),
                }).pipe(
                  Effect.andThen(priorDiscovery(probe.client)),
                  Effect.timeoutOrElse({
                    duration: timeoutMs,
                    orElse: () =>
                      Effect.fail(
                        boundaryError("timeout", "not-sent", "MCP stdio negotiation timed out."),
                      ),
                  }),
                ),
              ),
            ),
          ),
        );
        // Confirm SDK, root/group and pipes before the caller may launch the real child.
        yield* probe.close;
        return Exit.isFailure(result) ? yield* Effect.failCause(result.cause) : result.value;
      }),
    ),
  );
