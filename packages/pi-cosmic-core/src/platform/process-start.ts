import { nodeLockFs as fs, nodeSpawnSync } from "./node-builtins.ts";
import { signalProcess } from "./process-tree.ts";

const PS_TIMEOUT_MILLIS = 2_000;

/**
 * When a process started, as the OS reports it, or undefined when that can't be read. Together
 * with the PID it identifies one process, so a reused PID can be told apart from its predecessor.
 */
export const processStartIdentity = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the parenthesized command name start at field 3; start time is field 22.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    const result = nodeSpawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MILLIS,
    });
    const started = result.status === 0 ? result.stdout.trim() : "";
    return started === "" ? undefined : started;
  } catch {
    return undefined;
  }
};

/** One process: its PID and, when the OS reports it, its start identity. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly started?: string | undefined;
}

/**
 * `dead` needs positive evidence: the PID is absent, or it now belongs to a process that started
 * at a different time. A present PID without a comparable start identity stays `unknown`.
 */
export type ProcessLiveness = "alive" | "dead" | "unknown";

let ownIdentity: ProcessIdentity | undefined;

export const currentProcessIdentity = (): ProcessIdentity => {
  ownIdentity ??= { pid: process.pid, started: processStartIdentity(process.pid) };
  return ownIdentity;
};

export const processLiveness = (identity: ProcessIdentity): ProcessLiveness => {
  if (signalProcess(identity.pid, 0) === "absent") return "dead";
  if (identity.started === undefined) return "unknown";
  const started =
    identity.pid === process.pid
      ? currentProcessIdentity().started
      : processStartIdentity(identity.pid);
  if (started === undefined) return "unknown";
  return started === identity.started ? "alive" : "dead";
};
