// A stand-in for the Rex CLI. A "block" is a detached host process that runs the block's program
// with Rex's own variables, and like Rex, it stays when its program exits quickly: only closing
// it ends it. Which block a window shows is kept in a file named for the session, since each call
// is a new process. Two variables shape `session.new_block`: FAKE_REX_REPLY_DELAY_MS delays the
// reply after the block exists, and FAKE_REX_START_DELAY_MS delays its program; FAKE_REX_BLOCKS
// names a file that records each block's host process ID.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Schema from "effect/Schema";

const [first, second, third, fourth] = process.argv.slice(2);
const decodeNewBlock = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      session_id: Schema.String,
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
const delay = (name: string) => Number(process.env[name] ?? "0");

if (first === "__block") {
  // The block itself: `__block <session> <program> <args...>`.
  const [program, ...args] = process.argv.slice(4);
  const blockId = `block:${String(process.pid)}`;
  let running: ReturnType<typeof spawn> | undefined;
  process.on("SIGTERM", () => {
    if (running?.pid !== undefined)
      try {
        process.kill(-running.pid, "SIGTERM");
      } catch {}
    process.exit(0);
  });
  // A block stays until it is closed, whatever its program does.
  setInterval(() => undefined, 60_000);
  setTimeout(() => {
    running = spawn(program ?? "false", args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, REX_SESSION: second ?? "", REX_BLOCK: blockId },
    });
  }, delay("FAKE_REX_START_DELAY_MS"));
} else if (first === "api" && second === "call" && third === "session.new_block") {
  const { session_id, options } = decodeNewBlock(fourth ?? "");
  const host = spawn(
    process.execPath,
    [process.argv[1] ?? "", "__block", session_id, ...options.command],
    { cwd: options.cwd, detached: true, stdio: "ignore" },
  );
  host.unref();
  const blocks = process.env.FAKE_REX_BLOCKS;
  if (blocks) fs.appendFileSync(blocks, `${String(host.pid ?? 0)}\n`);
  // Rex has the block now; its reply may still be on the way when the caller is stopped.
  setTimeout(() => {
    process.stdout.write(`{"block_id":"block:${String(host.pid ?? 0)}","revision":1}\n`);
  }, delay("FAKE_REX_REPLY_DELAY_MS"));
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
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("No such block.");
    process.kill(pid, "SIGTERM");
  } catch {
    process.exitCode = 1;
  }
} else {
  process.exitCode = 1;
}
