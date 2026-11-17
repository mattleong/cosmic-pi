// A stand-in for the interactive Pi a Rex block runs: it names itself to the launcher's socket
// and answers each command with what only its environment and arguments could have told it.
import { createConnection } from "node:net";
import * as Schema from "effect/Schema";

const socket = createConnection(process.env.PI_SUBAGENT_REX_SOCKET ?? "");
const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, id: Schema.optional(Schema.String) })),
);
const decodeAsk = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      request: Schema.optional(Schema.Struct({ answer: Schema.optional(Schema.String) })),
    }),
  ),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const frame = (kind: string, value: Schema.Json) => socket.write(`${kind}${encode(value)}\n`);
let buffered = "";
socket.setEncoding("utf8");
socket.on("connect", () =>
  frame("H", { token: process.env.PI_SUBAGENT_REX_TOKEN ?? "", pid: process.pid, parked: false }),
);
socket.on("data", (chunk: string) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    // A questionnaire from the root is on screen at once, and answered only when it asks to be.
    if (line.startsWith("Q")) {
      const ask = decodeAsk(line.slice(1));
      if (ask.request === undefined) continue;
      frame("Q", { id: ask.id, shown: true });
      if (ask.request.answer !== undefined)
        frame("Q", { id: ask.id, outcome: { answered: ask.request.answer } });
      continue;
    }
    if (!line.startsWith("R")) continue;
    const command = decodeCommand(line.slice(1));
    frame("R", {
      type: "response",
      id: command.id ?? "",
      command: command.type,
      success: true,
      data: {
        runId: process.env.PI_SUBAGENT_RUN_ID ?? "",
        argv: process.argv.slice(2),
        pid: process.pid,
      },
    });
    frame("C", { channel: "pi-subagents", type: "user_input", text: "typed" });
  }
});
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(0));
