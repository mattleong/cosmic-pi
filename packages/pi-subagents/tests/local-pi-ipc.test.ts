import { describe, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { LocalPiContact, LocalPiParentControl } from "../src/backend/local-pi-protocol.ts";
import {
  attachLocalPiParentIpc,
  makeLocalPiChildIpcChannel,
  makeLocalPiParentIpcChannel,
  type LocalPiIpcPort,
} from "../src/boundary/local-pi-ipc.ts";
import { nodeSpawn as spawn } from "./support/node-builtins.ts";

const childFixture = fileURLToPath(new URL("./fixtures/local-pi-ipc-child.mjs", import.meta.url));

class IpcIntegrationTestError extends Schema.TaggedError<IpcIntegrationTestError>()(
  "IpcIntegrationTestError",
  { message: Schema.String },
) {}

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

  it.live("exchanges typed contacts and controls with a real IPC child", () =>
    Effect.gen(function* () {
      const child = spawn(process.execPath, [childFixture], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
      let detach = () => {};
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          detach();
          child.stderr?.destroy();
          if (child.exitCode === null) child.kill("SIGKILL");
        }),
      );

      const closed = yield* Deferred.make<
        { readonly code: number | null; readonly signal: NodeJS.Signals | null },
        IpcIntegrationTestError
      >();
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        Deferred.doneUnsafe(
          closed,
          Effect.fail(new IpcIntegrationTestError({ message: error.message })),
        );
      });
      child.once("close", (code, signal) => {
        Deferred.doneUnsafe(closed, Effect.succeed({ code, signal }));
      });

      const contacts = yield* Queue.unbounded<LocalPiContact>();
      const protocolErrors: string[] = [];
      let disconnects = 0;
      const ipc = attachLocalPiParentIpc(child, {
        onContact: (contact) => {
          Queue.offerUnsafe(contacts, contact);
        },
        onProtocolError: (message) => {
          protocolErrors.push(message);
        },
        onDisconnect: () => {
          disconnects += 1;
        },
      });
      detach = ipc.detach;

      const initial: LocalPiContact[] = [];
      for (let index = 0; index < 4; index += 1) {
        const hasReady = initial.some(
          (contact) => contact.type === "contact_parent" && contact.message === "child-ready",
        );
        const hasQuestion = initial.some(
          (contact) => contact.type === "contact_parent" && contact.kind === "question",
        );
        if (hasReady && hasQuestion) break;
        initial.push(yield* Queue.take(contacts).pipe(Effect.timeout("5 seconds")));
      }
      const question = initial.find(
        (contact) => contact.type === "contact_parent" && contact.kind === "question",
      );
      if (!question || question.type !== "contact_parent")
        return yield* new IpcIntegrationTestError({
          message: `Real IPC child did not ask its question: ${stderr}`,
        });

      yield* ipc.sendControl({
        channel: "pi-subagents",
        type: "peer_notice",
        message: "peer-live",
      });
      yield* ipc.sendControl({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: question.requestId,
        message: "reply-live",
      });

      const responses: LocalPiContact[] = [];
      for (let index = 0; index < 4; index += 1) {
        const hasPeer = responses.some(
          (contact) => contact.type === "contact_parent" && contact.message === "peer:peer-live",
        );
        const hasReply = responses.some(
          (contact) =>
            contact.type === "contact_parent" &&
            contact.message === `reply:${question.requestId}:reply-live`,
        );
        if (hasPeer && hasReply) break;
        responses.push(yield* Queue.take(contacts).pipe(Effect.timeout("5 seconds")));
      }

      expect(
        responses.some(
          (contact) => contact.type === "contact_parent" && contact.message === "peer:peer-live",
        ),
      ).toBe(true);
      expect(
        responses.some(
          (contact) =>
            contact.type === "contact_parent" &&
            contact.message === `reply:${question.requestId}:reply-live`,
        ),
      ).toBe(true);
      expect(yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))).toEqual({
        code: 0,
        signal: null,
      });
      expect(protocolErrors).toEqual([]);
      expect(disconnects).toBe(1);
      expect(stderr).toBe("");
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
