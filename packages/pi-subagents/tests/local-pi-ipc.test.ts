import { describe, expect, it } from "@effect/vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { spawnIpcChild } from "pi-cosmic-core/testing";
import type { LocalPiContact, LocalPiParentControl } from "../src/backend/local-pi-protocol.ts";
import {
  attachLocalPiParentIpc,
  makeLocalPiChildIpcChannel,
  makeLocalPiParentIpcChannel,
  type LocalPiIpcPort,
} from "../src/boundary/local-pi-ipc.ts";

const childFixture = fileURLToPath(new URL("./fixtures/local-pi-ipc-child.mjs", import.meta.url));

type SendBehavior = "success" | "error" | "pending" | "throw";

const fakePort = <Outbound>() => {
  const sent: Outbound[] = [];
  const events = new EventEmitter();
  let connected = true;
  let behavior: SendBehavior = "success";
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
    events,
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
    emitMessage: <MessageInput>(value: MessageInput) => events.emit("message", value),
    disconnect: () => events.emit("disconnect"),
  };
};

const parentReply = (message = "Proceed."): LocalPiParentControl => ({
  channel: "pi-subagents",
  type: "parent_reply",
  requestId: "question-1",
  ackId: "reply-ack-1",
  message,
});

const progressContact = (message = "Still working."): LocalPiContact => ({
  channel: "pi-subagents",
  type: "contact_parent",
  requestId: "progress-1",
  kind: "progress",
  message,
});

const ignoreParent = { onContact: () => {}, onProtocolError: () => {} };

const isQuestion = (contact: LocalPiContact) =>
  contact.type === "contact_parent" && contact.kind === "question";
const hasMessage = (message: string) => (contact: LocalPiContact) =>
  contact.type === "contact_parent" && contact.message === message;

describe("Local Pi IPC boundary", () => {
  it("decodes child contacts before exposing them and rejects malformed envelopes", () => {
    const fake = fakePort<LocalPiParentControl>();
    const contacts: LocalPiContact[] = [];
    const protocolErrors: string[] = [];
    const channel = makeLocalPiParentIpcChannel(fake.port, {
      onContact: (contact) => contacts.push(contact),
      onProtocolError: (message) => protocolErrors.push(message),
    });

    const acks: LocalPiContact[] = [
      { channel: "pi-subagents", type: "proxy_notification_ack", requestId: "n-1", ok: true },
      { channel: "pi-subagents", type: "turn_input_barrier_ack", requestId: "barrier-1" },
      { channel: "pi-subagents", type: "parent_reply_ack", requestId: "reply-1", ok: true },
    ];
    fake.emitMessage(progressContact());
    for (const ack of acks) fake.emitMessage(ack);
    fake.emitMessage({ type: "agent_settled" });

    expect(contacts).toEqual([progressContact(), ...acks]);
    expect(protocolErrors).toEqual(["Subagent emitted an invalid parent-contact event."]);

    channel.detach();
    fake.emitMessage(progressContact("late"));
    expect(contacts).toHaveLength(4);
  });

  it.effect("distinguishes definite parent-control rejection from uncertain delivery", () =>
    Effect.gen(function* () {
      const fake = fakePort<LocalPiParentControl>();
      const channel = makeLocalPiParentIpcChannel(fake.port, ignoreParent);

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
      const channel = makeLocalPiParentIpcChannel(fake.port, ignoreParent);
      const sending = yield* channel
        .sendControl(parentReply())
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(sending);
      expect(failure.code).toBe("transport_outcome_uncertain");
    }).pipe(Effect.scoped),
  );

  it.live("exchanges typed contacts and controls with a real IPC child", () =>
    Effect.gen(function* () {
      const { child, exited } = yield* spawnIpcChild(childFixture, [], { timeout: "5 seconds" });
      const contacts = yield* Queue.unbounded<LocalPiContact>();
      const protocolErrors: string[] = [];
      const ipc = attachLocalPiParentIpc(child, {
        onContact: (contact) => {
          Queue.offerUnsafe(contacts, contact);
        },
        onProtocolError: (message) => {
          protocolErrors.push(message);
        },
      });
      // Registered after the child's kill, so the listeners detach first.
      yield* Effect.addFinalizer(() => Effect.sync(ipc.detach));

      // Takes at most four contacts until every predicate has matched one of them.
      const takeUntil = (...predicates: ReadonlyArray<(contact: LocalPiContact) => boolean>) =>
        Effect.gen(function* () {
          const taken: LocalPiContact[] = [];
          for (let index = 0; index < 4; index += 1) {
            if (predicates.every((predicate) => taken.some(predicate))) break;
            taken.push(yield* Queue.take(contacts).pipe(Effect.timeout("5 seconds")));
          }
          return taken;
        });

      const initial = yield* takeUntil(hasMessage("child-ready"), isQuestion);
      const question = initial.find(isQuestion);
      if (!question || question.type !== "contact_parent")
        return yield* Effect.die(new Error("The real IPC child did not ask its question."));

      yield* ipc.sendControl({
        channel: "pi-subagents",
        type: "peer_notice",
        message: "peer-live",
      });
      yield* ipc.sendControl({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: question.requestId,
        ackId: "reply-live-ack",
        message: "reply-live",
      });

      const isPeer = hasMessage("peer:peer-live");
      const isReply = hasMessage(`reply:${question.requestId}:reply-live`);
      const responses = yield* takeUntil(isPeer, isReply);
      expect(responses.some(isPeer)).toBe(true);
      expect(responses.some(isReply)).toBe(true);
      // The fixture exits nonzero on any failure it observes.
      yield* exited;
      expect(child.exitCode).toBe(0);
      expect(protocolErrors).toEqual([]);
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
      disconnected = false;
      fake.emitMessage(parentReply("late"));
      fake.disconnect();
      expect(controls).toHaveLength(1);
      expect(disconnected).toBe(false);
    }),
  );
});
