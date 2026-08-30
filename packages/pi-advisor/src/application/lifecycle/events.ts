/** Internal lifecycle dispatcher. Pi registration stays in `application/register.ts`. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { AdvisorApplicationEvent } from "../controller.ts";
import { makeSessionLifecycle } from "./events/session.ts";
import { makeTrajectoryEventHandlers } from "./events/trajectory.ts";
import { makeTurnEventHandlers } from "./events/turn.ts";
import type { EventsDeps } from "./events/types.ts";

export type { EventsDeps } from "./events/types.ts";

export const makeLifecycleEvents = (d: EventsDeps) => {
  const lifecycle = makeSessionLifecycle(d);
  const turn = makeTurnEventHandlers(d);
  const trajectory = makeTrajectoryEventHandlers(d);

  const dispatchEvent = (
    input: AdvisorApplicationEvent,
    ctx: ExtensionContext,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      switch (input.type) {
        case "message_end":
          return turn.messageEnd(input.event, ctx);
        case "agent_settled":
          return turn.agentSettled(input.event, ctx);
        case "turn_end":
          return turn.turnEnd(input.event, ctx);
        case "turn_start":
          return trajectory.turnStart(input.event, ctx);
        case "message_update":
          return trajectory.messageUpdate(input.event);
        case "tool_execution_start":
          return trajectory.toolExecutionStart(input.event);
        case "tool_execution_update":
          return trajectory.toolExecutionUpdate(input.event);
        case "tool_execution_end":
          return trajectory.toolExecutionEnd(input.event);
      }
    });

  return { ...lifecycle, dispatchEvent };
};
