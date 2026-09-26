import type { EventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuthFlow } from "../../src/auth/flow.ts";
import { boundaryError } from "../../src/client/errors.ts";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  normalizeMcpCodeModeCapability,
  type McpCodeModeCapability,
} from "../../src/code-mode/protocol.ts";
import type { McpManagerSnapshot } from "../../src/manager/model.ts";
import { McpManager } from "../../src/manager/service.ts";

const emptyManager: McpManagerSnapshot = {
  revision: 1,
  trusted: true,
  enabled: true,
  active: 0,
  queued: 0,
  servers: [],
};
/** Real activity with inert auth-flow and manager presentation services. */
export const presentationLayer = Layer.mergeAll(
  McpActivity.layer(),
  Layer.succeed(McpAuthFlow, {
    subscribe: () => Effect.void,
    run: () => Effect.succeed({ state: "ready" }),
  }),
  Layer.succeed(McpManager, {
    refresh: Effect.succeed(emptyManager),
    snapshot: () => emptyManager,
    subscribe: () => Effect.void,
    withView: (effect) => effect,
    capture: () => Effect.fail(boundaryError("unsupported", "not-sent", "fixture")),
    check: () => Effect.void,
    dispatch: () => Effect.succeed(undefined),
    cached: (request) =>
      Effect.succeed({
        family: request.family,
        entries: [],
        catalogs: [],
        total: 0,
        next: undefined,
      }),
    cachedDetail: () => Effect.fail(boundaryError("not-found", "not-sent", "fixture")),
  }),
);
export const host = <A>(run: () => PromiseLike<A>) => Effect.tryPromise(run);

/** Emits one session capability query and returns the normalized providers that answered. */
export const queryCodeMode = (events: EventBus, sessionId: string) => {
  const found: McpCodeModeCapability[] = [];
  events.emit(MCP_CODE_MODE_QUERY, {
    version: MCP_CODE_MODE_VERSION,
    sessionId,
    respond: <Value>(value: Value) => {
      const candidate = normalizeMcpCodeModeCapability(value);
      if (candidate) found.push(candidate);
    },
  });
  return found;
};
