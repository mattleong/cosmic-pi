import type { Client } from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { MCP_BOUNDARY_LIMITS, type McpCapabilities, type McpConnection } from "../client/model.ts";
import type { McpProtocolAdapter } from "./mcp-protocol/contract.ts";
import { sdkHandshake } from "./sdk-client.ts";
import { terminalExchange } from "./sdk-elicitation.ts";
import {
  observeSdkCleanup,
  sdkCapabilities,
  type SdkConnectionState,
  type SdkEvents,
} from "./sdk-events.ts";

export const boundedInt = (minimum: number, maximum: number) =>
  Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(minimum),
    Schema.isLessThanOrEqualTo(maximum),
  );

const limit = (maximum: number, fallback: number) =>
  boundedInt(1, maximum).pipe(Schema.withDecodingDefaultKey(Effect.succeed(fallback)));

/** Protocol and limit fields shared by both transports; omitted keys take boundary defaults. */
export const SdkLimitFields = {
  protocol: Schema.Literals(["auto", "legacy"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("auto")),
  ),
  connectTimeoutMs: limit(10 * 60 * 1_000, MCP_BOUNDARY_LIMITS.connectTimeoutMs),
  requestTimeoutMs: limit(60 * 60 * 1_000, MCP_BOUNDARY_LIMITS.requestTimeoutMs),
  cleanupTimeoutMs: limit(30 * 1_000, MCP_BOUNDARY_LIMITS.cleanupTimeoutMs),
  requestBytes: limit(64 * 1024 * 1024, MCP_BOUNDARY_LIMITS.requestBytes),
  responseBytes: limit(64 * 1024 * 1024, MCP_BOUNDARY_LIMITS.responseBytes),
};

type SdkExchange = NonNullable<McpConnection["exchange"]>;

/** Acquisition authority the driver lends to one transport's native `connect`. */
export interface SdkAcquisition {
  readonly state: SdkConnectionState;
  /** Remaining connection budget; fails once the acquisition deadline expires. */
  readonly remaining: Effect.Effect<number, McpBoundaryError>;
  /** The driver's outer `uninterruptibleMask` restore. */
  readonly restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Replaces the native cleanup that close joins. */
  readonly setCleanup: (cleanup: Effect.Effect<void, McpBoundaryError>) => void;
}

/** Native resources one transport hands back after its handshake. */
export interface SdkNativeConnection {
  readonly client: Client;
  readonly events: SdkEvents;
  readonly protocol: McpProtocolAdapter;
  /** Built after observation because HTTP dispatch depends on negotiated capabilities. */
  readonly exchange: (capabilities: McpCapabilities) => SdkExchange;
  readonly setToken?: McpConnection["setToken"];
}

export interface SdkConnectionPlan {
  /**
   * Deliberate per-transport close policy, guarded by each transport's suite. It also
   * selects the HTTP-only capabilities.
   * - `http`: full close joins every operation, including any previously timed-out lease,
   *   before the owner scope closes, so it recomputes cleanup evidence.
   * - `stdio`: subscription finalizers must send cancellation before the SDK settles its
   *   listens and the native writer becomes unavailable. Native cleanup then always runs,
   *   and failed cancellation writes and native uncertainty stay sticky.
   */
  readonly transport: "http" | "stdio";
  /** Agent-visible messages stay specific to each transport. */
  readonly labels: { readonly deadline: string; readonly cleanup: string };
  readonly snapshot: {
    readonly connectTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly cleanupTimeoutMs: number;
    readonly onCleanup: ((confirmed: boolean) => void) | undefined;
  };
  /** Runs synchronously when close starts, even before `connect`. */
  readonly onClosing?: () => void;
  /** Late-bound so close can finish events published during a failed acquisition. */
  readonly events: () => SdkEvents | undefined;
  readonly connect: (
    acquisition: SdkAcquisition,
  ) => Effect.Effect<SdkNativeConnection, McpBoundaryError, Scope.Scope>;
}

/**
 * Open and initialize one scoped SDK connection. The driver owns the acquisition
 * deadline, owner scope, cached close, cleanup evidence, observation budget, and
 * assembly; each transport supplies native acquisition, its exchange, and close policy.
 */
export const openSdkConnection = (
  plan: SdkConnectionPlan,
): Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const { snapshot } = plan;
      const deadline = (yield* Clock.currentTimeMillis) + snapshot.connectTimeoutMs;
      const remaining = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          now < deadline
            ? Effect.succeed(deadline - now)
            : Effect.fail(boundaryError("timeout", "not-sent", plan.labels.deadline)),
        ),
      );
      const owner = yield* Scope.fork(yield* Effect.scope);
      const state: SdkConnectionState = {
        closing: false,
        closed: false,
        cleanupUnconfirmed: false,
      };
      let opening: Fiber.Fiber<McpConnection, McpBoundaryError> | undefined;
      let cleanup: Effect.Effect<void, McpBoundaryError> = Effect.void;
      // Scope replacement joins initialization before observing cleanup, and no
      // acquisition can hand off new resources after cleanup publication.
      const begin = Effect.sync(() => {
        state.closing = true;
        plan.onClosing?.();
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => (opening === undefined ? Effect.void : Fiber.interrupt(opening))),
        ),
      );
      const nativeCleanup = Effect.suspend(() => cleanup);
      const closeOwner = Scope.close(owner, Exit.void);
      const ordered =
        plan.transport === "http"
          ? begin.pipe(Effect.andThen(nativeCleanup), Effect.ensuring(closeOwner))
          : begin.pipe(
              Effect.andThen(closeOwner),
              Effect.ensuring(
                nativeCleanup.pipe(
                  Effect.exit,
                  Effect.map((exit) => {
                    state.cleanupUnconfirmed ||= Exit.isFailure(exit);
                  }),
                ),
              ),
            );
      // The owned cleanup and its cached result stay masked. Interrupting the first
      // caller cannot cache an interrupted, incomplete close. Native cleanup retains
      // its own bounded escalation policy.
      const cachedClose = yield* Effect.cached(
        Effect.uninterruptible(
          ordered.pipe(
            Effect.exit,
            Effect.flatMap((exit) => {
              state.closed = true;
              const failed = Exit.isFailure(exit) || state.observationCleanupFailed === true;
              state.cleanupUnconfirmed =
                plan.transport === "http" ? failed : state.cleanupUnconfirmed || failed;
              observeSdkCleanup(snapshot.onCleanup, !state.cleanupUnconfirmed);
              const failure = state.cleanupUnconfirmed
                ? boundaryError("cleanup", "unknown", plan.labels.cleanup)
                : undefined;
              plan.events()?.finish(failure);
              return failure === undefined ? Effect.void : Effect.fail(failure);
            }),
          ),
        ),
      );
      const close = Effect.uninterruptible(cachedClose);
      yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
      const acquire = Effect.gen(function* () {
        if (state.closing)
          return yield* boundaryError("connection", "not-sent", "MCP connection is unavailable.");
        const native = yield* plan.connect({
          state,
          remaining,
          restore,
          setCleanup: (next) => {
            cleanup = next;
          },
        });
        const { client, events, protocol } = native;
        const observationBudget = yield* remaining;
        yield* restore(
          protocol.observe(client, events, observationBudget, snapshot.cleanupTimeoutMs),
        ).pipe(
          Effect.timeoutOrElse({
            duration: observationBudget,
            orElse: () =>
              Effect.fail(
                boundaryError("timeout", "not-sent", "MCP metadata observation timed out."),
              ),
          }),
        );
        const capabilities = yield* sdkCapabilities(client, plan.transport === "http");
        const handshake = yield* sdkHandshake(client);
        const exchange = native.exchange(capabilities);
        const connection: McpConnection = {
          capabilities,
          ...handshake,
          subscribeResource: (uri, identity) =>
            protocol.subscribeResource(
              client,
              events,
              uri,
              snapshot.requestTimeoutMs,
              snapshot.cleanupTimeoutMs,
              identity,
            ),
          changes: events.changes,
          remoteEvents: events.remoteEvents,
          remoteEventDrops: events.remoteEventDrops,
          terminal: events.terminal,
          health: events.health,
          setToken: native.setToken ?? (() => Effect.void),
          close,
          exchange,
          request: (input, options) =>
            exchange(input, options).pipe(Effect.flatMap(terminalExchange)),
        };
        return connection;
      }).pipe(Effect.provideService(Scope.Scope, owner));
      opening = yield* Effect.forkIn(acquire, owner, { uninterruptible: true });
      return yield* restore(Fiber.join(opening)).pipe(
        Effect.catchCause((cause) =>
          (Cause.hasInterrupts(cause) ? close.pipe(Effect.ignore) : close).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );
    }),
  );
