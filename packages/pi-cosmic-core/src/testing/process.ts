import { currentProcessIdentity } from "../platform/process-start.ts";

/**
 * This process's PID with a comparable start identity of some other process, as a record left by
 * that PID's previous owner would hold it.
 */
export const reusedProcessIdentity = () => {
  const { pid, started } = currentProcessIdentity();
  if (started === undefined) throw new Error("This platform reports no process start identity.");
  // Every start identity ends in a decimal start time; another digit names another time.
  return { pid, started: `${started}0` };
};
