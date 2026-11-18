import type { Terminal } from "@earendil-works/pi-tui";
import type { Socket } from "node:net";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";

const MAX_FRAME = 1024 * 1024;
const dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }));
const decodeFrame = decodeUnknownOrUndefined(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ columns: dimension, rows: dimension }),
      Schema.Struct({ key: Schema.String }),
    ]),
  ),
);

/** The second TUI writes to this pane's socket, never to the root Pi's stdin/stdout. */
export function acceptViewTerminal(socket: Socket, ready: (terminal: Terminal) => void): void {
  let columns = 0,
    rows = 0;
  let input: ((key: string) => void) | undefined;
  let resize: (() => void) | undefined;
  const write = (data: string): void => {
    if (socket.destroyed) return;
    if (socket.writableLength > 4 * MAX_FRAME) socket.destroy();
    else socket.write(data);
  };
  const terminal: Terminal = {
    start: (onInput, onResize) => {
      input = onInput;
      resize = onResize;
    },
    stop: () => {
      input = undefined;
      resize = undefined;
    },
    drainInput: () => Promise.resolve(),
    write,
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    // The client's ProcessTerminal already splits negotiated keyboard sequences.
    kittyProtocolActive: false,
    moveBy: (n) => {
      if (n) write(`\x1b[${Math.abs(n)}${n > 0 ? "B" : "A"}`);
    },
    hideCursor: () => write("\x1b[?25l"),
    showCursor: () => write("\x1b[?25h"),
    clearLine: () => write("\x1b[2K"),
    clearFromCursor: () => write("\x1b[J"),
    clearScreen: () => write("\x1b[2J\x1b[H"),
    setTitle: Fn.constVoid,
    setProgress: Fn.constVoid,
    setProgramStatus: Fn.constVoid,
  };
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const lines = Str.split(buffered + chunk, "\n");
    buffered = lines.pop() ?? "";
    if (buffered.length > MAX_FRAME) {
      socket.destroy();
      return;
    }
    for (const line of lines) {
      const frame = line.length <= MAX_FRAME ? decodeFrame(line) : undefined;
      if (!frame) {
        socket.destroy();
        return;
      }
      if ("key" in frame) {
        input?.(frame.key);
        continue;
      }
      const first = columns === 0;
      columns = frame.columns;
      rows = frame.rows;
      if (first) ready(terminal);
      else resize?.();
    }
  });
}
