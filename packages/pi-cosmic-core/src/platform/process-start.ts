import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { nodeLockFs as fs, nodeSpawnSync } from "./node-builtins.ts";
import { runBoundedProcessNode } from "./process.ts";
import { signalProcess } from "./process-tree.ts";

const PS_EXECUTABLE = "/bin/ps";
const PS_TIMEOUT_MILLIS = 2_000;
const PS_OUTPUT_LIMIT_BYTES = 1_024;
/** `ps` prints `lstart` in the caller's time zone and locale; fixing both makes it stable. */
const PS_ENVIRONMENT = { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" };
const psArguments = (pid: number) => ["-o", "lstart=", "-p", String(pid)];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `lstart` in the C locale, such as `Sun Oct 18 20:54:19 2026`. */
const C_LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * Each platform reports start identities in one scheme. Identities compare only within the
 * current platform's scheme; anything else is incomparable evidence.
 */
const PROC_SCHEME = "proc";
const PS_UTC_SCHEME = "ps-utc";
const currentScheme = process.platform === "linux" ? PROC_SCHEME : PS_UTC_SCHEME;
const COMPARABLE = new RegExp(`^${currentScheme}:\\d+$`);

const utcSeconds = (lstart: string): number | undefined => {
  const match = C_LSTART.exec(lstart);
  if (!match) return undefined;
  const [, month = "", day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex === -1) return undefined;
  const millis = Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
  return Number.isFinite(millis) ? millis / 1000 : undefined;
};

const procStartIdentity = (pid: number): string | undefined => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // Fields after the parenthesized command name start at field 3; start time is field 22.
  const commandEnd = Option.getOrElse(Fn.pipe(stat, Str.lastIndexOf(")")), () => -1);
  const ticks = Str.split(Fn.pipe(stat, Str.slice(commandEnd + 2)), " ")[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? `${PROC_SCHEME}:${ticks}` : undefined;
};

const psStartIdentity = (status: number | null, stdout: string): string | undefined => {
  const seconds = status === 0 ? utcSeconds(Str.trim(stdout)) : undefined;
  return seconds === undefined ? undefined : `${PS_UTC_SCHEME}:${seconds}`;
};

/**
 * When a process started, as the OS reports it, or undefined when that can't be read. Together
 * with the PID it identifies one process, so a reused PID can be told apart from its predecessor.
 * Linux reports start ticks since boot as `proc:<ticks>`; macOS reports `lstart` read in UTC and
 * the C locale as `ps-utc:<epoch seconds>`, so the identity doesn't depend on the environment.
 *
 * On macOS this blocks the event loop on `ps` for up to two seconds. It exists for synchronous
 * ownership commits, such as the cross-process lock's, where an asynchronous gap would let another
 * owner act between the check and the commit; everything else uses `probeProcessLiveness`.
 */
export const processStartIdentity = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") return procStartIdentity(pid);
    const result = nodeSpawnSync(PS_EXECUTABLE, psArguments(pid), {
      encoding: "utf8",
      env: PS_ENVIRONMENT,
      timeout: PS_TIMEOUT_MILLIS,
    });
    return psStartIdentity(result.status, result.stdout);
  } catch {
    return undefined;
  }
};

/**
 * `processStartIdentity` without blocking: macOS runs `ps` through the bounded process runner
 * under the same deadline. A failed, overflowing, or late `ps` reads as undefined.
 */
const probeStartIdentity = (pid: number): Effect.Effect<string | undefined> =>
  process.platform === "linux"
    ? // A procfs read is served from kernel memory and doesn't wait on another process.
      // The process can exit, or procfs can refuse the read, after the signal probe found it.
      Effect.try(() => procStartIdentity(pid)).pipe(Effect.orElseSucceed(() => undefined))
    : runBoundedProcessNode({
        executable: PS_EXECUTABLE,
        args: psArguments(pid),
        environment: PS_ENVIRONMENT,
        stdoutLimitBytes: PS_OUTPUT_LIMIT_BYTES,
        stderrLimitBytes: PS_OUTPUT_LIMIT_BYTES,
        timeoutMillis: PS_TIMEOUT_MILLIS,
      }).pipe(
        Effect.map((result) =>
          result.overflowed || result.timedOut
            ? undefined
            : psStartIdentity(result.code, result.stdout),
        ),
        Effect.orElseSucceed(() => undefined),
      );

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

/** Compares the start identity recorded for a present PID with the one the OS reports now. */
const livenessFromStart = (recorded: string, started: string | undefined): ProcessLiveness => {
  if (started === undefined) return "unknown";
  if (started === recorded) return "alive";
  // A recorded identity in another scheme or format can't prove the PID was reused.
  return COMPARABLE.test(recorded) ? "dead" : "unknown";
};

/**
 * Synchronous liveness, which can block on `ps` (see `processStartIdentity`). Only a synchronous
 * ownership commit should use it; other callers use `probeProcessLiveness`.
 */
export const processLiveness = (identity: ProcessIdentity): ProcessLiveness => {
  if (signalProcess(identity.pid, 0) === "absent") return "dead";
  if (identity.started === undefined) return "unknown";
  const started =
    identity.pid === process.pid
      ? currentProcessIdentity().started
      : processStartIdentity(identity.pid);
  return livenessFromStart(identity.started, started);
};

/** `processLiveness` without blocking the event loop; the same evidence gives the same answer. */
export const probeProcessLiveness = (identity: ProcessIdentity): Effect.Effect<ProcessLiveness> =>
  Effect.suspend(() => {
    if (signalProcess(identity.pid, 0) === "absent") return Effect.succeed("dead" as const);
    const recorded = identity.started;
    if (recorded === undefined) return Effect.succeed("unknown" as const);
    const started =
      identity.pid === process.pid && ownIdentity !== undefined
        ? Effect.succeed(ownIdentity.started)
        : probeStartIdentity(identity.pid);
    return Effect.map(started, (value) => livenessFromStart(recorded, value));
  });
