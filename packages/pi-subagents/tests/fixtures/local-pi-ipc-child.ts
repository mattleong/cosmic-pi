import * as Effect from "effect/Effect";
import type { LocalPiParentControl } from "../../src/backend/local-pi-protocol.ts";
import { openLocalPiChildIpc } from "../../src/boundary/local-pi-ipc.ts";

const ipc = openLocalPiChildIpc();
let detach = () => {};
let peerReceived = false;
let replyReceived = false;
let handling = Promise.resolve();

const fail = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Local Pi IPC fixture failed.";
  process.stderr.write(`${message}\n`);
  detach();
  process.exitCode = 2;
  process.disconnect?.();
};

const sendContact = (requestId: string, kind: "progress" | "question", message: string) =>
  ipc.sendContact({ channel: "pi-subagents", type: "contact_parent", requestId, kind, message });

const finishWhenAnswered = () => {
  if (!peerReceived || !replyReceived) return;
  detach();
  process.disconnect?.();
};

const handleControl = (control: LocalPiParentControl) =>
  Effect.gen(function* () {
    if (control.type === "peer_notice") {
      peerReceived = true;
      yield* sendContact("fixture-peer", "progress", `peer:${control.message}`);
    } else if (control.type === "parent_reply") {
      replyReceived = true;
      yield* sendContact(
        "fixture-reply",
        "progress",
        `reply:${control.requestId}:${control.message}`,
      );
    }
    finishWhenAnswered();
  });

detach = ipc.listen({
  onControl: (control) => {
    handling = handling.then(() => Effect.runPromise(handleControl(control))).catch(fail);
  },
  onDisconnect: () => {
    detach();
  },
});

Effect.runPromise(
  sendContact("fixture-ready", "progress", "child-ready").pipe(
    Effect.andThen(sendContact("fixture-question", "question", "fixture-question")),
  ),
).catch(fail);
