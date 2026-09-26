// Delegated-Pi supervisor bridge: one in-process authenticated connection to the root channel.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { SupervisorMcpToolArgumentsByName } from "../supervisor/mcp-contract.ts";
import { MAX_SUPERVISOR_CHANNEL_LINE_BYTES } from "../supervisor/protocol.ts";
import {
  decodeSupervisorToolCall,
  runSupervisorTool,
  SupervisorToolFailure,
} from "../supervisor/tool-call.ts";
import { nodePath } from "./node-builtins.ts";
import { openSupervisorClient } from "./supervisor-client.ts";
import { readConfig } from "./supervisor-mcp-config.ts";

type SupervisorToolName = keyof SupervisorMcpToolArgumentsByName;

const MAX_ACTIVE_CALLS = 16;
// Bounds a blocking question; every other non-proxy call's own 10 s bound fires first.
const OUTER_TIMEOUT_MILLIS = 10 * 60_000;
const PROXY_TIMEOUT_MILLIS = 60 * 60_000;
// Room for the RPC envelope, authentication, request identity, and an escaped tool name.
const FRAME_ENVELOPE_BYTES = 4 * 1024;

export class PiSupervisorBridgeError extends Schema.TaggedError<PiSupervisorBridgeError>()(
  "PiSupervisorBridgeError",
  {
    reason: Schema.Literals(["rejected", "timeout", "transport", "capacity"]),
    message: Schema.String,
  },
) {}

const bridgeError = (reason: PiSupervisorBridgeError["reason"], message: string) =>
  new PiSupervisorBridgeError({ reason, message });
const rejected = () => bridgeError("rejected", "The private supervisor rejected this call.");

// The root closes a connection whose NDJSON line exceeds its bound, so oversized calls fail here.
const proxyFrameFits = (argumentsJson: string): boolean =>
  Buffer.byteLength(JSON.stringify(argumentsJson), "utf8") + FRAME_ENVELOPE_BYTES <=
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES;

export interface PiSupervisorBridgeClient {
  readonly call: <Name extends SupervisorToolName>(
    name: Name,
    input: SupervisorMcpToolArgumentsByName[Name],
  ) => Effect.Effect<string, PiSupervisorBridgeError>;
}

export interface PiSupervisorBridgeOpenOptions {
  readonly onNotification?: ((message: string) => void) | undefined;
}

/** Opens one authenticated supervisor connection bound to the caller's Scope. */
export const openPiSupervisorBridge = (
  configPath: string,
  options: PiSupervisorBridgeOpenOptions = {},
): Effect.Effect<PiSupervisorBridgeClient, PiSupervisorBridgeError, Scope.Scope> =>
  Effect.gen(function* () {
    // The bounded path grammar the helper-era bridge accepted, normalized as the helper did.
    if (
      configPath.length > 4_096 ||
      !nodePath.isAbsolute(configPath) ||
      /[\0\r\n]/u.test(configPath)
    )
      return yield* bridgeError("transport", "Private supervisor configuration path is invalid.");
    const client = yield* readConfig(nodePath.resolve(configPath)).pipe(
      Effect.flatMap((config) =>
        // Session shutdown can race a notification; a throw is contained and still acknowledged.
        openSupervisorClient(config, (message) =>
          Effect.try({
            try: () => options.onNotification?.(message),
            catch: () => bridgeError("transport", "Delegated Pi notification delivery failed."),
          }).pipe(Effect.ignore),
        ),
      ),
      Effect.mapError(() =>
        bridgeError("transport", "Private supervisor channel could not be opened."),
      ),
    );
    let active = 0;
    const admit = Effect.suspend(() => {
      if (active >= MAX_ACTIVE_CALLS)
        return Effect.fail(
          bridgeError("capacity", "Private supervisor bridge is at its concurrent-call bound."),
        );
      active += 1;
      return Effect.void;
    });
    return {
      call: (name, input) =>
        Effect.suspend(() => {
          const call = decodeSupervisorToolCall(name, input);
          if (!call) return Effect.fail(rejected());
          if (call.kind === "proxy" && !proxyFrameFits(call.argumentsJson))
            return Effect.fail(
              bridgeError("capacity", "A private supervisor request exceeds its frame bound."),
            );
          const result = runSupervisorTool(client, call).pipe(
            Effect.mapError((error) =>
              error instanceof SupervisorToolFailure
                ? bridgeError("transport", error.message)
                : rejected(),
            ),
            Effect.flatMap(({ text, isError }) =>
              isError ? Effect.fail(rejected()) : Effect.succeed(text),
            ),
          );
          return Effect.acquireUseRelease(
            admit,
            () =>
              result.pipe(
                Effect.timeoutOrElse({
                  duration: call.kind === "proxy" ? PROXY_TIMEOUT_MILLIS : OUTER_TIMEOUT_MILLIS,
                  orElse: () =>
                    Effect.fail(bridgeError("timeout", "Private supervisor call timed out.")),
                }),
              ),
            () =>
              Effect.sync(() => {
                active -= 1;
              }),
          );
        }),
    };
  });
