// Typed Local Pi parent-contact protocol over the inherited raw Node IPC channel.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { LocalPiContact, LocalPiParentControl } from "../backend/local-pi-protocol.ts";
import {
  decodeLocalPiContactOption,
  decodeLocalPiParentControlOption,
} from "../backend/local-pi-protocol.ts";
import { processCauseError, type SubagentProcessError } from "../run/errors.ts";
import type { NodeChildProcess } from "./node-builtins.ts";

const IPC_WRITE_TIMEOUT = "10 seconds";

type IpcMessageListener = <MessageInput>(message: MessageInput) => void;
type IpcDisconnectListener = () => void;

export interface LocalPiIpcPort<Outbound> {
  readonly connected: () => boolean;
  readonly send: (message: Outbound, callback: (error: Error | null) => void) => void;
  readonly addMessageListener: (listener: IpcMessageListener) => void;
  readonly removeMessageListener: (listener: IpcMessageListener) => void;
  readonly addDisconnectListener: (listener: IpcDisconnectListener) => void;
  readonly removeDisconnectListener: (listener: IpcDisconnectListener) => void;
}

export class ParentContactError extends Schema.TaggedError<ParentContactError>()(
  "ParentContactError",
  { message: Schema.String, code: Schema.optional(Schema.String) },
) {}

const boundedSend = <Message, Failure>(
  port: LocalPiIpcPort<Message>,
  message: Message,
  notSent: () => Failure,
  uncertain: () => Failure,
): Effect.Effect<void, Failure> =>
  Effect.callback<void, Failure>((resume) => {
    if (!port.connected()) {
      resume(Effect.fail(notSent()));
      return;
    }
    try {
      port.send(message, (error) => resume(error ? Effect.fail(uncertain()) : Effect.void));
    } catch {
      resume(Effect.fail(notSent()));
    }
  }).pipe(
    Effect.timeoutOption(IPC_WRITE_TIMEOUT),
    Effect.flatMap((outcome) => (Option.isSome(outcome) ? Effect.void : Effect.fail(uncertain()))),
  );

const attachListeners = <Outbound, Inbound>(
  port: LocalPiIpcPort<Outbound>,
  decode: <Input>(input: Input) => Option.Option<Inbound>,
  onMessage: (message: Inbound) => void,
  onInvalidMessage: () => void,
  onDisconnect: () => void,
): (() => void) => {
  let attached = true;
  const messageListener: IpcMessageListener = (raw) => {
    const decoded = decode(raw);
    if (Option.isSome(decoded)) onMessage(decoded.value);
    else onInvalidMessage();
  };
  const disconnectListener = () => onDisconnect();
  port.addMessageListener(messageListener);
  port.addDisconnectListener(disconnectListener);
  return () => {
    if (!attached) return;
    attached = false;
    port.removeMessageListener(messageListener);
    port.removeDisconnectListener(disconnectListener);
  };
};

export interface LocalPiParentIpcHandlers {
  readonly onContact: (contact: LocalPiContact) => void;
  readonly onProtocolError: (message: string) => void;
  readonly onDisconnect: () => void;
}

export interface LocalPiParentIpcChannel {
  readonly sendControl: (
    control: LocalPiParentControl,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly detach: () => void;
}

export const makeLocalPiParentIpcChannel = (
  port: LocalPiIpcPort<LocalPiParentControl>,
  handlers: LocalPiParentIpcHandlers,
): LocalPiParentIpcChannel => {
  const detach = attachListeners(
    port,
    decodeLocalPiContactOption,
    handlers.onContact,
    () => handlers.onProtocolError("Subagent emitted an invalid parent-contact event."),
    handlers.onDisconnect,
  );
  return {
    sendControl: (control) =>
      boundedSend(
        port,
        control,
        () =>
          processCauseError("send IPC message to", "Subagent IPC is closed.", "transport_not_sent"),
        () =>
          processCauseError(
            "send IPC message to",
            "Subagent IPC delivery did not settle within its bound.",
            "transport_outcome_uncertain",
          ),
      ),
    detach,
  };
};

const parentPort = (child: NodeChildProcess): LocalPiIpcPort<LocalPiParentControl> => ({
  connected: () => child.connected,
  send: (message, callback) => {
    child.send(message, callback);
  },
  addMessageListener: (listener) => {
    child.on("message", listener);
  },
  removeMessageListener: (listener) => {
    child.off("message", listener);
  },
  addDisconnectListener: (listener) => {
    child.on("disconnect", listener);
  },
  removeDisconnectListener: (listener) => {
    child.off("disconnect", listener);
  },
});

export const attachLocalPiParentIpc = (
  child: NodeChildProcess,
  handlers: LocalPiParentIpcHandlers,
): LocalPiParentIpcChannel => makeLocalPiParentIpcChannel(parentPort(child), handlers);

export interface LocalPiChildIpcHandlers {
  readonly onControl: (control: LocalPiParentControl) => void;
  readonly onDisconnect: () => void;
}

export interface LocalPiChildIpcChannel {
  readonly sendContact: (contact: LocalPiContact) => Effect.Effect<void, ParentContactError>;
  readonly listen: (handlers: LocalPiChildIpcHandlers) => () => void;
}

export const makeLocalPiChildIpcChannel = (
  port: LocalPiIpcPort<LocalPiContact>,
): LocalPiChildIpcChannel => ({
  sendContact: (contact) =>
    boundedSend(
      port,
      contact,
      () =>
        new ParentContactError({
          code: "transport_not_sent",
          message: "The parent subagent supervisor is unavailable.",
        }),
      () =>
        new ParentContactError({
          code: "transport_outcome_uncertain",
          message: "Unable to confirm delivery to the parent subagent supervisor.",
        }),
    ),
  listen: (handlers) =>
    attachListeners(
      port,
      decodeLocalPiParentControlOption,
      handlers.onControl,
      () => {},
      handlers.onDisconnect,
    ),
});

const childPort = (): LocalPiIpcPort<LocalPiContact> => ({
  connected: () => process.send !== undefined && process.connected,
  send: (message, callback) => {
    const send = process.send;
    if (!send) throw new Error("Node IPC is unavailable.");
    send.call(process, message, callback);
  },
  addMessageListener: (listener) => {
    process.on("message", listener);
  },
  removeMessageListener: (listener) => {
    process.off("message", listener);
  },
  addDisconnectListener: (listener) => {
    process.on("disconnect", listener);
  },
  removeDisconnectListener: (listener) => {
    process.off("disconnect", listener);
  },
});

export const openLocalPiChildIpc = (): LocalPiChildIpcChannel =>
  makeLocalPiChildIpcChannel(childPort());
