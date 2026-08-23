import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { LocalPiContact, LocalPiParentControl } from "../src/backend/local-pi-protocol.ts";
import {
  makeLocalPiChildIpcChannel,
  makeLocalPiParentIpcChannel,
  type LocalPiIpcPort,
} from "../src/boundary/local-pi-ipc.ts";

type TestMessageListener = <MessageInput>(message: MessageInput) => void;
type SendBehavior = "success" | "error" | "pending" | "throw";

const fakePort = <Outbound>() => {
  const sent: Outbound[] = [];
  let connected = true;
  let behavior: SendBehavior = "success";
  let messageListener: TestMessageListener | undefined;
  let disconnectListener: (() => void) | undefined;
  const port: LocalPiIpcPort<Outbound> = {
    connected: () => connected,
    send: (message, callback) => {
      sent.push(message);
      switch (behavior) {
        case "success":
          callback(null);
          return;
        case "error":
          callback(new Error("ambiguous write"));
          return;
        case "pending":
          return;
        case "throw":
          throw new Error("write was not dispatched");
      }
    },
    addMessageListener: (listener) => {
      messageListener = listener;
    },
    removeMessageListener: (listener) => {
      if (messageListener === listener) messageListener = undefined;
    },
    addDisconnectListener: (listener) => {
      disconnectListener = listener;
    },
    removeDisconnectListener: (listener) => {
      if (disconnectListener === listener) disconnectListener = undefined;
    },
  };
  return {
    port,
    sent,
    setConnected: (value: boolean) => {
      connected = value;
    },
    setBehavior: (value: SendBehavior) => {
      behavior = value;
    },
    emitMessage: <MessageInput>(value: MessageInput) => messageListener?.(value),
    disconnect: () => disconnectListener?.(),
  };
};

const parentReply = (message = "Proceed."): LocalPiParentControl => ({
  channel: "pi-subagents",
  type: "parent_reply",
  requestId: "question-1",
  message,
});

const progressContact = (message = "Still working."): LocalPiContact => ({
  channel: "pi-subagents",
  type: "contact_parent",
  requestId: "progress-1",
  kind: "progress",
  message,
});

describe("Local Pi IPC boundary", () => {
  it("decodes child contacts before exposing them and rejects malformed envelopes", () => {
    const fake = fakePort<LocalPiParentControl>();
    const contacts: LocalPiContact[] = [];
    const protocolErrors: string[] = [];
    let disconnects = 0;
    const channel = makeLocalPiParentIpcChannel(fake.port, {
      onContact: (contact) => contacts.push(contact),
      onProtocolError: (message) => protocolErrors.push(message),
      onDisconnect: () => {
        disconnects += 1;
      },
    });

    fake.emitMessage(progressContact());
    fake.emitMessage({ type: "agent_settled" });
    fake.disconnect();

    expect(contacts).toEqual([progressContact()]);
    expect(protocolErrors).toEqual(["Subagent emitted an invalid parent-contact event."]);
    expect(disconnects).toBe(1);

    channel.detach();
    fake.emitMessage(progressContact("late"));
    fake.disconnect();
    expect(contacts).toHaveLength(1);
    expect(disconnects).toBe(1);
  });

  it.effect("distinguishes definite parent-control rejection from uncertain delivery", () =>
    Effect.gen(function* () {
      const fake = fakePort<LocalPiParentControl>();
      const channel = makeLocalPiParentIpcChannel(fake.port, {
        onContact: () => {},
        onProtocolError: () => {},
        onDisconnect: () => {},
      });

      yield* channel.sendControl(parentReply());
      expect(fake.sent).toEqual([parentReply()]);

      fake.setConnected(false);
      const disconnected = yield* channel
        .sendControl(parentReply("Disconnected"))
        .pipe(Effect.flip);
      expect(disconnected.code).toBe("transport_not_sent");

      fake.setConnected(true);
      fake.setBehavior("throw");
      const notDispatched = yield* channel.sendControl(parentReply("Throw")).pipe(Effect.flip);
      expect(notDispatched.code).toBe("transport_not_sent");

      fake.setBehavior("error");
      const callbackFailure = yield* channel.sendControl(parentReply("Callback")).pipe(Effect.flip);
      expect(callbackFailure.code).toBe("transport_outcome_uncertain");
    }),
  );

  it.effect("bounds a parent-control write whose callback never settles", () =>
    Effect.gen(function* () {
      const fake = fakePort<LocalPiParentControl>();
      fake.setBehavior("pending");
      const channel = makeLocalPiParentIpcChannel(fake.port, {
        onContact: () => {},
        onProtocolError: () => {},
        onDisconnect: () => {},
      });
      const sending = yield* channel
        .sendControl(parentReply())
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(sending);
      expect(failure.code).toBe("transport_outcome_uncertain");
    }).pipe(Effect.scoped),
  );

  it.effect("validates parent controls before the child consumes them", () =>
    Effect.gen(function* () {
      const fake = fakePort<LocalPiContact>();
      const controls: LocalPiParentControl[] = [];
      let disconnected = false;
      const channel = makeLocalPiChildIpcChannel(fake.port);
      const detach = channel.listen({
        onControl: (control) => controls.push(control),
        onDisconnect: () => {
          disconnected = true;
        },
      });

      fake.emitMessage(parentReply());
      fake.emitMessage({ channel: "pi-subagents", type: "unknown" });
      fake.disconnect();
      expect(controls).toEqual([parentReply()]);
      expect(disconnected).toBe(true);

      yield* channel.sendContact(progressContact());
      expect(fake.sent).toEqual([progressContact()]);

      fake.setConnected(false);
      const notSent = yield* channel.sendContact(progressContact("closed")).pipe(Effect.flip);
      expect(notSent.code).toBe("transport_not_sent");

      fake.setConnected(true);
      fake.setBehavior("error");
      const uncertain = yield* channel.sendContact(progressContact("ambiguous")).pipe(Effect.flip);
      expect(uncertain.code).toBe("transport_outcome_uncertain");

      detach();
      fake.emitMessage(parentReply("late"));
      expect(controls).toHaveLength(1);
    }),
  );
});
