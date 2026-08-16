// Node process-tree ownership is intentionally isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";

const isNoSuchProcess = <ErrorInput>(error: ErrorInput): boolean =>
  hasObjectRuntimeType(error) && error !== null && "code" in error && error.code === "ESRCH";

export interface ProcessTreeRuntime {
  readonly platform?: NodeJS.Platform;
  readonly taskkillTimeoutMillis?: number;
  readonly spawnTaskkill?: (pid: number, mode: "graceful" | "force") => NodeChildProcess;
}

const defaultSpawnTaskkill = (pid: number, mode: "graceful" | "force"): NodeChildProcess =>
  spawn("taskkill", ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])], {
    stdio: "ignore",
    windowsHide: true,
  });

/**
 * Signal the process tree owned by a detached child. POSIX process groups remain
 * addressable after their leader exits. Windows PID ownership does not, so an
 * already-exited leader is never passed to taskkill until Job Objects are used.
 */
export async function terminateProcessTree(
  child: NodeChildProcess,
  mode: "graceful" | "force",
  runtime: ProcessTreeRuntime = {},
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const platform = runtime.platform ?? process.platform;
  if (platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timeoutMillis = runtime.taskkillTimeoutMillis ?? 2_000;
    const spawnTaskkill = runtime.spawnTaskkill ?? defaultSpawnTaskkill;
    await new Promise<void>((resolve, reject) => {
      const killer = spawnTaskkill(pid, mode);
      killer.unref?.();
      let settled = false;
      const finish = (result: { readonly error?: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killer.off("error", onError);
        killer.off("close", onClose);
        if (result.error === undefined) resolve();
        else reject(result.error);
      };
      const onError = (error: Error) => finish({ error });
      const onClose = (code: number | null) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) finish({});
        else finish({ error: new Error(`taskkill exited with code ${code ?? "unknown"}.`) });
      };
      const timer = setTimeout(() => {
        // A timed-out helper no longer owns this Promise, but a delayed spawn error
        // must still be observed after the primary listeners are removed.
        killer.on("error", () => {});
        finish({ error: new Error(`taskkill timed out after ${timeoutMillis} ms.`) });
        try {
          killer.kill();
        } catch {
          // Timeout already owns completion even if the helper cannot be killed.
        }
      }, timeoutMillis);
      killer.once("error", onError);
      killer.once("close", onClose);
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
