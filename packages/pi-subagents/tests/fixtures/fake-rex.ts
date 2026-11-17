// A stand-in for the Rex CLI: a "block" is a detached process, and closing one kills it.
import { spawn } from "node:child_process";
import * as Schema from "effect/Schema";

const [first, second, third, fourth] = process.argv.slice(2);
const decodeNewBlock = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      options: Schema.Struct({ command: Schema.Array(Schema.String), cwd: Schema.String }),
    }),
  ),
);

if (first === "api" && second === "call" && third === "session.new_block") {
  const { options } = decodeNewBlock(fourth ?? "");
  const [program, ...args] = options.command;
  const child = spawn(program ?? "false", args, {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.stdout.write(`{"block_id":"block:${String(child.pid ?? 0)}","revision":1}\n`);
} else if (first === "block" && second === "close") {
  const pid = Number((process.argv.at(-1) ?? "").replace("block:", ""));
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
} else {
  process.exitCode = 1;
}
