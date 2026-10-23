import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";

/** An unspawned Node child whose pipes the test drives, with stdin writes it can stall. */
export const scriptedChildProcess = () => {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  let stalled = false;
  let completeWrite: ((error?: Error | null) => void) | undefined;
  const stdin = new Writable({
    decodeStrings: false,
    write(chunk: string, _encoding, callback) {
      writes.push(chunk);
      if (stalled) completeWrite = callback;
      else callback();
    },
  });
  Object.defineProperties(child, {
    pid: { value: 4242 },
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  return {
    child,
    stdout,
    stderr,
    stdin,
    writes,
    finish: () => {
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("close", 0, null);
    },
    stall: () => {
      stalled = true;
    },
    completeWrite: (error?: Error) => completeWrite?.(error),
  };
};
