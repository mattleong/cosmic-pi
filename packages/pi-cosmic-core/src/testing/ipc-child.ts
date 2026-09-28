import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  nodeFsPromises,
  nodePath,
  nodeSpawn,
  nodeTemporaryRoot,
} from "../platform/node-builtins.ts";

type IpcChildProcess = ReturnType<typeof nodeSpawn>;
type IpcMessage = Parameters<IpcChildProcess["send"]>[0];

/** A real temporary directory removed when the scope closes; fixture I/O failure is a defect. */
export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => nodeFsPromises.mkdtemp(nodePath.join(nodeTemporaryRoot(), prefix))),
    (directory) =>
      Effect.promise(() => nodeFsPromises.rm(directory, { recursive: true, force: true })),
  );

const exitOf = (child: IpcChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    const exited = () => resume(Effect.void);
    child.once("exit", exited);
    return Effect.sync(() => child.off("exit", exited));
  });

/** Sends SIGKILL and waits for exit; an already-exited child settles at once. */
export const killChild = (child: IpcChildProcess) =>
  Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(exitOf(child)));

export interface IpcChildOptions {
  /** Bounds each `wait` and `exited`. */
  readonly timeout: Duration.Input;
  /** Replaces the inherited environment when given. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Stderr kept for failure reports; older output is dropped so a chatty child never blocks. */
const STDERR_TAIL = 4_096;

/**
 * Runs a TypeScript fixture through `jiti/register` (resolved from the working directory)
 * with an IPC channel. Every message is recorded from spawn, and stderr is drained into a
 * bounded tail. A wait that times out fails with what the child did send, its exit status and
 * stderr, so a slow or stuck fixture explains itself. Scope closure kills the child.
 */
export const spawnIpcChild = (
  script: string,
  args: ReadonlyArray<string>,
  options: IpcChildOptions,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = nodeSpawn(process.execPath, ["--import", "jiti/register", script, ...args], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        ...(options.env && { env: options.env }),
      });
      const messages: IpcMessage[] = [];
      child.on("message", (message) => messages.push(message));
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      const stuck = (expected: string) =>
        new Error(
          [
            `Timed out waiting for ${JSON.stringify(expected)} from ${nodePath.basename(script)} ${args.join(" ")}.`,
            `Received: ${JSON.stringify(messages)}.`,
            `Exit: ${child.exitCode ?? child.signalCode ?? "still running"}.`,
            ...(stderr.trim() === "" ? [] : [`Stderr (tail):\n${stderr.trim()}`]),
          ].join("\n"),
        );
      /** Settles once `expected` has arrived, including before the call. */
      const wait = (expected: string) =>
        Effect.callback<void>((resume) => {
          if (messages.includes(expected)) {
            resume(Effect.void);
            return;
          }
          const receive = (message: IpcMessage) => {
            if (message === expected) resume(Effect.void);
          };
          child.on("message", receive);
          return Effect.sync(() => child.off("message", receive));
        }).pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () => Effect.die(stuck(expected)),
          }),
        );
      return { child, messages, wait, exited: exitOf(child).pipe(Effect.timeout(options.timeout)) };
    }),
    ({ child }) => killChild(child),
  );
