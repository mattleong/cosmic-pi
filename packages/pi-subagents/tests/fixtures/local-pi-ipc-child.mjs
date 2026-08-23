const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const Effect = await import("effect/Effect");
const { openLocalPiChildIpc } = await jiti.import("../../src/boundary/local-pi-ipc.ts");

const ipc = openLocalPiChildIpc();
let detach = () => {};
let peerReceived = false;
let replyReceived = false;
let handling = Promise.resolve();

const fail = (error) => {
  const message = error instanceof Error ? error.message : "Local Pi IPC fixture failed.";
  process.stderr.write(`${message}\n`);
  detach();
  process.exitCode = 2;
  process.disconnect?.();
};

const sendProgress = (requestId, message) =>
  Effect.runPromise(
    ipc.sendContact({
      channel: "pi-subagents",
      type: "contact_parent",
      requestId,
      kind: "progress",
      message,
    }),
  );

const handleControl = async (control) => {
  if (control.type === "peer_notice") {
    peerReceived = true;
    await sendProgress("fixture-peer", `peer:${control.message}`);
  } else {
    replyReceived = true;
    await sendProgress("fixture-reply", `reply:${control.requestId}:${control.message}`);
  }
  if (peerReceived && replyReceived) {
    detach();
    process.disconnect?.();
  }
};

detach = ipc.listen({
  onControl: (control) => {
    handling = handling.then(() => handleControl(control));
    void handling.catch(fail);
  },
  onDisconnect: () => {
    detach();
  },
});

try {
  await sendProgress("fixture-ready", "child-ready");
  await Effect.runPromise(
    ipc.sendContact({
      channel: "pi-subagents",
      type: "contact_parent",
      requestId: "fixture-question",
      kind: "question",
      message: "fixture-question",
    }),
  );
} catch (error) {
  fail(error);
}
