// A stand-in for the Rex CLI: a "block" is a detached process, and closing one kills it. Which
// block a window shows is kept in a file named for the session, since each call is a new process.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Schema from "effect/Schema";

const [first, second, third, fourth] = process.argv.slice(2);
const decodeNewBlock = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      options: Schema.Struct({ command: Schema.Array(Schema.String), cwd: Schema.String }),
    }),
  ),
);
const decodeTarget = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ session_id: Schema.String, block_id: Schema.optional(Schema.String) }),
  ),
);
/** Where a session's placed block is recorded; the test that hides a pane writes it too. */
const placementFile = (session: string) =>
  path.join(os.tmpdir(), `fake-rex-${session.replaceAll(/[^A-Za-z0-9]/gu, "-")}.json`);

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
} else if (first === "api" && second === "call" && third === "session.move_block") {
  const target = decodeTarget(fourth ?? "");
  fs.writeFileSync(
    placementFile(target.session_id),
    JSON.stringify({ blocks: [{ block_id: target.block_id ?? "", placement: "placed" }] }),
  );
  process.stdout.write("{}\n");
} else if (first === "api" && second === "call" && third === "session.list_blocks") {
  const file = placementFile(decodeTarget(fourth ?? "").session_id);
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : '{"blocks":[]}');
} else if (first === "block" && second === "focus") {
  // Focus changes nothing a test reads.
} else if (first === "block" && second === "close") {
  const pid = Number((process.argv.at(-1) ?? "").replace("block:", ""));
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
} else {
  process.exitCode = 1;
}
