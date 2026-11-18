import type { Socket } from "node:net";
import type { Terminal } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import * as Fn from "effect/Function";
import { invokeBestEffort } from "pi-cosmic-core/host-session";
import {
  nodeCreateServer,
  nodeFs,
  nodePath,
  nodeTemporaryRoot,
} from "pi-cosmic-core/platform/node-builtins";
import { acceptViewTerminal } from "./rex-view-terminal.ts";

export type OpenWriterView = (terminal: Terminal, signal: AbortSignal) => Promise<void>;

const CLIENT = fileURLToPath(new URL("./rex-view-client.mjs", import.meta.url));
// Rex can keep an exited block. Even if its creation reply is lost, the block closes itself
// when it cannot connect or when its owner's socket disappears. It never starts a shell prompt.
const VIEW_COMMAND = '"$1" "$2" "$3"; exec "$4" block close -s "$REX_SESSION" "$REX_BLOCK"';

/** Owns one short-lived screen connection, not a process or checkout belonging to the writer. */
export function writerViewConnection(rex: string, open: OpenWriterView, onEnd: () => void) {
  const directory = nodeFs.mkdtempSync(nodePath.join(nodeTemporaryRoot(), "pisv-"));
  const path = nodePath.join(directory, "v");
  const controller = new AbortController();
  let peer: Socket | undefined;
  const server = nodeCreateServer((socket) => {
    socket.on("error", Fn.constVoid);
    if (controller.signal.aborted || peer) {
      socket.destroy();
      return;
    }
    peer = socket;
    server.close();
    socket.once("close", close);
    socket.setTimeout(15_000, close);
    acceptViewTerminal(socket, (terminal) => {
      if (controller.signal.aborted) return;
      socket.setTimeout(0);
      void Promise.resolve()
        .then(() => (controller.signal.aborted ? undefined : open(terminal, controller.signal)))
        .then(close)
        .catch(close);
    });
  });
  function close() {
    if (controller.signal.aborted) return;
    controller.abort();
    peer?.destroy();
    if (server.listening) server.close();
    invokeBestEffort(() => nodeFs.rmSync(directory, { recursive: true, force: true }));
    onEnd();
  }
  server.once("error", close);
  server.once("close", () => {
    if (!peer) close();
  });
  try {
    server.listen({ path, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    close();
    throw error;
  }
  return {
    close,
    command: ["/bin/sh", "-c", VIEW_COMMAND, "writer-view", process.execPath, CLIENT, path, rex],
  };
}
