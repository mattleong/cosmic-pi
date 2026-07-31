// Independent-process fixture for the real private writer-lease filesystem protocol.
import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";
import { makeWriterLease } from "../../src/boundary/writer-lease.ts";

const [agentDirectory, project, runId] = process.argv.slice(2);
if (!agentDirectory || !project || !runId) process.exit(2);

const writerLeases = makeWriterLease({ agentDirectory });
const cwd = await Effect.runPromise(writerLeases.canonicalize(project));
let lease;
let chain = Promise.resolve();

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const execute = async (command) => {
  try {
    if (command === "acquire") {
      lease = await Effect.runPromise(
        writerLeases.acquire({ cwd, sessionId: `child-${process.pid}`, runId }),
      );
      write({ type: "acquired", runId, pid: process.pid, phase: lease.evidence.phase });
      return;
    }
    if (command === "mark") {
      if (!lease) throw new Error("missing lease");
      lease = await Effect.runPromise(writerLeases.markSpawnStarted(lease));
      write({ type: "marked", runId, phase: lease.evidence.phase });
      return;
    }
    if (command === "release") {
      if (!lease) throw new Error("missing lease");
      await Effect.runPromise(writerLeases.release(lease));
      lease = undefined;
      write({ type: "released", runId });
      return;
    }
    if (command === "exit") {
      write({ type: "exiting", runId });
      process.exit(0);
    }
    throw new Error("unknown command");
  } catch (error) {
    write({
      type: "failure",
      runId,
      tag: error?._tag ?? "Error",
      reason: error?.reason,
      ownerRunId: error?.ownerRunId,
      message: error?.message ?? String(error),
    });
  }
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  chain = chain.then(() => execute(line));
});
write({ type: "ready", runId, pid: process.pid });
