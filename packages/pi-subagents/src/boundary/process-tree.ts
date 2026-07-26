// Node process-tree ownership is intentionally isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/asyncFunction:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";

const isNoSuchProcess = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";

/**
 * Signal the process tree owned by a detached child. On POSIX the process group
 * remains addressable after its original leader exits, so group cleanup must not
 * be gated by the leader's exitCode/signalCode. Windows taskkill remains best
 * effort after the leader exits until a native Job Object boundary is available.
 */
export async function terminateProcessTree(
  child: NodeChildProcess,
  mode: "graceful" | "force",
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new Error(`taskkill exited with code ${code ?? "unknown"}.`));
      });
    });
    return;
  }

  const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    // If the group could not be signalled while the leader is still alive, retain
    // the direct-child fallback used for unusual spawn/platform configurations.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.kill(signal)) return;
      } catch {
        // Preserve the original group-signalling failure below.
      }
    }
    throw error;
  }
}
