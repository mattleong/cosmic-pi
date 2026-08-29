/** Internal lifecycle dispatcher. Pi registration stays in `application/register.ts`. */
import type {
  AgentSettledEvent,
  ExtensionContext,
  MessageEndEvent,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
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
    name: string,
    event: AdvisorApplicationEvent,
    ctx: ExtensionContext,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      switch (name) {
        case "message_end":
          // SAFETY: application/register.ts forwards only Pi message_end events with this name.
          return turn.messageEnd(event as MessageEndEvent, ctx);
        case "agent_settled":
          // SAFETY: application/register.ts forwards only Pi agent_settled events with this name.
          return turn.agentSettled(event as AgentSettledEvent, ctx);
        case "turn_end":
          // SAFETY: application/register.ts forwards only Pi turn_end events with this name.
          return turn.turnEnd(event as TurnEndEvent, ctx);
        case "turn_start":
          // SAFETY: application/register.ts forwards only Pi turn_start events with this name.
          return trajectory.turnStart(event as TurnStartEvent, ctx);
        case "message_update":
          // SAFETY: application/register.ts forwards only Pi message_update events with this name.
          return trajectory.messageUpdate(event as MessageUpdateEvent);
        case "tool_execution_start":
          // SAFETY: application/register.ts forwards only Pi tool_execution_start events with this name.
          return trajectory.toolExecutionStart(event as ToolExecutionStartEvent);
        case "tool_execution_update":
          // SAFETY: application/register.ts forwards only Pi tool_execution_update events with this name.
          return trajectory.toolExecutionUpdate(event as ToolExecutionUpdateEvent);
        case "tool_execution_end":
          // SAFETY: application/register.ts forwards only Pi tool_execution_end events with this name.
          return trajectory.toolExecutionEnd(event as ToolExecutionEndEvent);
        default:
          return Effect.void;
      }
    });

  return { ...lifecycle, dispatchEvent };
};
