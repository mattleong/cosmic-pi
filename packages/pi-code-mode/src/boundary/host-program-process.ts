/**
 * Starts the Node process that runs one Code Mode program. The process owner, pipes and
 * process-group cleanup belong to core's duplex process in side-channel mode.
 */
import { fileURLToPath } from "node:url";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  openDuplexProcess,
  type DuplexProcessError,
  type DuplexProcessHandle,
} from "pi-cosmic-core";

// Module URLs are real paths (Node and Jiti resolve symlinks). The permission allowlist needs
// them: Node resolves the entry's real path under the same permissions it grants.
const CHILD_PATH = fileURLToPath(new URL("./code-mode-child.mjs", import.meta.url));
const WATCHDOG_PATH = fileURLToPath(new URL("./code-mode-watchdog.mjs", import.meta.url));

/** Retained program stdout and stderr. One extra byte shows that output was cut. */
export const PROGRAM_OUTPUT_BYTES = 256 * 1024;

/** V8 old-space ceiling for one program. */
const MAX_OLD_SPACE_MB = 1024;

/**
 * Node's permission model: the program may compute, use built-in modules and the network, but
 * reading or writing files, importing project modules, starting processes, native addons and
 * WASI are refused, so file and process work goes through the recorded `tools.pi.*` calls. Only
 * the runner's own two files are readable, and the watchdog needs a worker thread. This routes
 * effects; it is not a sandbox, since `tools.pi.bash` can do anything.
 *
 * Node 25+ also denies the network under `--permission`; earlier versions cannot, and reject
 * `--allow-net` as unknown. Allowing it where Node knows the flag keeps one rule on every version.
 * The program runs on Pi's own Node, so this process's flags describe the child's.
 */
const PERMISSIONS = [
  "--permission",
  `--allow-fs-read=${CHILD_PATH}`,
  `--allow-fs-read=${WATCHDOG_PATH}`,
  "--allow-worker",
  ...(process.allowedNodeEnvironmentFlags.has("--allow-net") ? ["--allow-net"] : []),
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=SecurityWarning",
];

const INHERITED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "LANGUAGE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/**
 * A minimal environment: locale, paths, proxies and certificates, never NODE_OPTIONS or Pi's
 * own variables. This avoids accidental inheritance; it does not hide secrets from code that
 * can run a shell.
 */
export const programEnvironment = (source: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) =>
      value !== undefined && (INHERITED.has(key) || key.startsWith("LC_") || key.startsWith("XDG_"))
        ? [[key, value] as const]
        : [],
    ),
  );

export interface ProgramProcessOptions {
  readonly cwd: string;
  /** Upper bound for one reply write; the execution deadline governs overall. */
  readonly writeTimeoutMs: number;
  readonly onCleanup: (confirmed: boolean) => void;
}

export type ProgramProcess = DuplexProcessHandle;

export const openProgramProcess = (
  options: ProgramProcessOptions,
): Effect.Effect<ProgramProcess, DuplexProcessError, Scope.Scope> =>
  openDuplexProcess({
    command: process.execPath,
    args: [...PERMISSIONS, `--max-old-space-size=${MAX_OLD_SPACE_MB}`, CHILD_PATH],
    cwd: options.cwd,
    environment: programEnvironment(process.env),
    sideChannel: true,
    maxReadQueueBytes: 64 * 1024 * 1024,
    maxWriteBytes: 512 * 1024 * 1024,
    maxWriteQueueBytes: 512 * 1024 * 1024,
    writeTimeoutMs: options.writeTimeoutMs,
    maxStderrBytes: PROGRAM_OUTPUT_BYTES + 1,
    maxStderrQueueBytes: PROGRAM_OUTPUT_BYTES + 1,
    startTimeoutMs: 10_000,
    onCleanup: options.onCleanup,
  });
