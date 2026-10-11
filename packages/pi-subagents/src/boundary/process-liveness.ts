import { signalProcess } from "pi-cosmic-core";
import { nodeUptime } from "./node-builtins.ts";

export const currentBootTime = (now: number): number => Math.round(now - nodeUptime() * 1_000);

export const isProcessAlive = (pid: number): boolean => {
  const probe = signalProcess(pid, 0);
  return probe === "present" || probe === "permission";
};
