// External editor integration is a narrow Node/Pi host boundary.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export function captureExternalEditorCommand(ctx: ExtensionContext): string | undefined {
  try {
    return SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getExternalEditorCommand();
  } catch {
    return undefined;
  }
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // The process already settled.
  }
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" || !child.pid) {
    killChild(child);
    return;
  }
  try {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => killChild(child));
  } catch {
    killChild(child);
  }
}

function launch(command: string, file: string, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    if (file.includes('"')) {
      reject(new Error("External-editor temporary path contains an unsupported quote."));
      return;
    }
    const child =
      process.platform === "win32"
        ? spawn(`${command} "${file}"`, {
            shell: true,
            stdio: "inherit",
          })
        : spawn("/bin/sh", ["-c", `exec ${command} "$1"`, "pi-ask-user-editor", file], {
            stdio: "inherit",
          });
    let settled = false;
    const abort = () => terminate(child);
    const exit = () => killChild(child);
    const clear = () => {
      signal.removeEventListener("abort", abort);
      process.removeListener("exit", exit);
    };
    signal.addEventListener("abort", abort, { once: true });
    process.once("exit", exit);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clear();
      resolve(code);
    });
  });
}

export async function editWithExternalEditor(
  tui: TUI,
  configuredCommand: string | undefined,
  value: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const command = configuredCommand ?? (process.platform === "win32" ? "notepad" : "nano");
  const directory = await mkdtemp(join(tmpdir(), "pi-ask-user-"));
  const file = join(directory, "answer.md");
  try {
    await writeFile(file, value, "utf8");
    tui.stop();
    const status = await launch(command, file, signal);
    if (signal.aborted) return undefined;
    if (status !== 0) throw new Error(`External editor exited with status ${status ?? "unknown"}.`);
    return (await readFile(file, "utf8")).replace(/\n$/, "");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    try {
      tui.start();
      tui.requestRender(true);
    } catch {
      // The session may have shut down while the editor was open.
    }
  }
}
