import { signalProcess } from "pi-cosmic-core";
import { nodeUptime } from "./node-builtins.ts";

/**
 * When this machine booted, in epoch milliseconds, from the wall-clock time `now` and the
 * system's uptime, which keeps counting while the machine sleeps. A record naming another boot
 * names a process that is gone, whatever process holds its pid now.
 */
export const currentBootTime = (now: number): number => Math.round(now - nodeUptime() * 1_000);

/**
 * Whether a process with `pid` is running, probed with signal 0. A permission error means it
 * runs under another user, or that a sandbox forbids the probe, so it counts as alive; only a
 * missing process is dead.
 */
export const isProcessAlive = (pid: number): boolean => {
  const probe = signalProcess(pid, 0);
  return probe === "present" || probe === "permission";
};
