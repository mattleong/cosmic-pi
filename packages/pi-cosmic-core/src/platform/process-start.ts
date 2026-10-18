import { nodeLockFs as fs, nodeSpawnSync } from "./node-builtins.ts";
import { signalProcess } from "./process-tree.ts";

const PS_TIMEOUT_MILLIS = 2_000;
/** `ps` prints `lstart` in the caller's time zone and locale; fixing both makes it stable. */
const PS_ENVIRONMENT = { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" };
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

/**
 * When a process started, as the OS reports it, or undefined when that can't be read. Together
 * with the PID it identifies one process, so a reused PID can be told apart from its predecessor.
 * Linux reports start ticks since boot as `proc:<ticks>`; macOS reports `lstart` read in UTC and
 * the C locale as `ps-utc:<epoch seconds>`, so the identity doesn't depend on the environment.
 */
export const processStartIdentity = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the parenthesized command name start at field 3; start time is field 22.
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks !== undefined && /^\d+$/.test(ticks) ? `${PROC_SCHEME}:${ticks}` : undefined;
    }
    const result = nodeSpawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: PS_ENVIRONMENT,
      timeout: PS_TIMEOUT_MILLIS,
    });
    const seconds = result.status === 0 ? utcSeconds(result.stdout.trim()) : undefined;
    return seconds === undefined ? undefined : `${PS_UTC_SCHEME}:${seconds}`;
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
  if (started === identity.started) return "alive";
  // A recorded identity in another scheme or format can't prove the PID was reused.
  return COMPARABLE.test(identity.started) ? "dead" : "unknown";
};
