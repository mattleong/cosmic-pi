import * as Schema from "effect/Schema";
import { SupervisorRpcFailure } from "../supervisor/protocol.ts";

export class SupervisorChannelError extends Schema.TaggedError<SupervisorChannelError>()(
  "SupervisorChannelError",
  {
    operation: Schema.String,
    code: Schema.String,
    message: Schema.String,
  },
) {}

export const channelError = (operation: string, code: string, message: string) =>
  new SupervisorChannelError({ operation, code, message });
export const epochError = (code: string, message: string) =>
  channelError("set assignment epoch", code, message);
export const rpcFailure = (code: string, message: string) =>
  new SupervisorRpcFailure({ code, message });
export const eventQueueFull = () =>
  rpcFailure("event_queue_full", "Supervisor event queue is full.");
