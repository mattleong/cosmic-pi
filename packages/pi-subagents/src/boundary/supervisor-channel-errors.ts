import * as Schema from "effect/Schema";
import { SupervisorRpcFailure } from "../supervisor/protocol.ts";

export class SupervisorChannelError extends Schema.TaggedError<
  SupervisorChannelError,
  { readonly brand: unique symbol }
>()("SupervisorChannelError", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

export const channelError = (operation: string, code: string, message: string) =>
  SupervisorChannelError.make({ operation, code, message });
export const epochError = (code: string, message: string) =>
  channelError("set assignment epoch", code, message);
export const rpcFailure = (code: string, message: string) =>
  SupervisorRpcFailure.make({ code, message });
export const eventQueueFull = () =>
  rpcFailure("event_queue_full", "Supervisor event queue is full.");
