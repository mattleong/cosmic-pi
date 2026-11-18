// @ts-check
// Only a keyboard and a display. The writer, its checkout and its tools stay with the root.
import { createConnection } from "node:net";
import { ProcessTerminal } from "@earendil-works/pi-tui";

const path = process.argv[2];
if (!path) throw new Error("Missing writer view socket");
const socket = createConnection(path);
const terminal = new ProcessTerminal();
let started = false;
/** @param {object} value */
const send = (value) => {
  if (socket.destroyed) return;
  if (socket.writableLength > 1024 * 1024) socket.destroy();
  else socket.write(JSON.stringify(value) + "\n");
};
const size = () => send({ columns: terminal.columns, rows: terminal.rows });
socket.once("connect", () => {
  started = true;
  size();
  terminal.start((key) => send({ key }), size);
  // The root writes display bytes only. Pipe backpressure prevents a stalled Rex terminal
  // from accumulating output in this process.
  socket.pipe(process.stdout, { end: false });
});
socket.on("error", () => socket.destroy());
socket.once("close", () => {
  if (started) terminal.stop();
  process.exit(0);
});
