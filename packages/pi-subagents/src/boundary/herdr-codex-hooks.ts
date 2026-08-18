// Codex hook discovery/trust and its bounded app-server process live at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { terminateProcessTree } from "./process-tree.ts";

const CODEX_EXECUTABLE = "codex";
const CALL_TIMEOUT_MILLIS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

const BoundedText = Schema.String.check(Schema.isMaxLength(4_096));
const BoundedNonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const HookEntrySchema = Schema.Struct({
  key: BoundedNonEmptyText,
  eventName: Schema.Literal("sessionStart"),
  handlerType: Schema.Literal("command"),
  matcher: Schema.NullOr(BoundedText),
  command: Schema.NullOr(BoundedText),
  sourcePath: BoundedNonEmptyText,
  source: Schema.Literal("user"),
  pluginId: Schema.Null,
  enabled: Schema.Boolean,
  isManaged: Schema.Boolean,
  currentHash: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(HASH_PATTERN),
  ),
  trustStatus: Schema.Literals(["managed", "untrusted", "trusted", "modified"] as const),
});
const HooksListResultSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: BoundedNonEmptyText,
      hooks: Schema.Array(HookEntrySchema).check(Schema.isMaxLength(64)),
      warnings: Schema.Array(BoundedText).check(Schema.isMaxLength(64)),
      errors: Schema.Array(Schema.Struct({ path: BoundedText, message: BoundedText })).check(
        Schema.isMaxLength(64),
      ),
    }),
  ).check(Schema.isMaxLength(8)),
});
const ConfigWriteResultSchema = Schema.Struct({
  status: Schema.Literals(["ok", "okOverridden"] as const),
  version: BoundedNonEmptyText,
  filePath: BoundedNonEmptyText,
  overriddenMetadata: Schema.NullOr(Schema.MutableJson),
});
const RpcSuccessSchema = Schema.Struct({ id: BoundedNonEmptyText, result: Schema.MutableJson });
const RpcFailureSchema = Schema.Struct({
  id: BoundedNonEmptyText,
  error: Schema.Struct({ code: BoundedText, message: BoundedText }),
});

type HookEntry = Schema.Schema.Type<typeof HookEntrySchema>;
type RpcSuccess = Schema.Schema.Type<typeof RpcSuccessSchema>;
type RpcFailure = Schema.Schema.Type<typeof RpcFailureSchema>;
type RpcResponse = RpcSuccess | RpcFailure;

export class HerdrCodexHooksError extends Schema.TaggedError<HerdrCodexHooksError>()(
  "HerdrCodexHooksError",
  {
    code: Schema.Literals([
      "codex_herdr_hook_unavailable",
      "codex_herdr_hook_cleanup_unconfirmed",
    ] as const),
  },
) {}

export const isHerdrCodexHooksError = <ErrorInput>(
  error: ErrorInput,
): error is ErrorInput & HerdrCodexHooksError => error instanceof HerdrCodexHooksError;

export interface HerdrCodexHooksContract {
  readonly establishTrust: (input: {
    readonly codexHome: string;
    readonly configPath: string;
    readonly hooksPath: string;
    readonly cwd: string;
    readonly command: string;
  }) => Promise<void>;
}

export interface HerdrCodexHooksOptions {
  /** Test seam only. Production always uses the fixed `codex` executable. */
  readonly executable?: string | undefined;
  /** Captured parent environment. CODEX_HOME is always replaced with private harness state. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Test seam only. */
  readonly timeoutMillis?: number | undefined;
}

interface PendingResponse {
  readonly resolve: (value: RpcResponse) => void;
  readonly reject: (error: HerdrCodexHooksError) => void;
  readonly timer: NodeJS.Timeout;
}

interface RpcSession {
  readonly call: (id: string, method: string, params: Schema.MutableJson) => Promise<RpcResponse>;
  readonly notify: (method: string, params: Schema.MutableJson) => Promise<void>;
  readonly close: () => Promise<void>;
}

const unavailable = () => new HerdrCodexHooksError({ code: "codex_herdr_hook_unavailable" });
const cleanupUnconfirmed = () =>
  new HerdrCodexHooksError({ code: "codex_herdr_hook_cleanup_unconfirmed" });

const writeFrame = <ValueInput>(child: NodeChildProcess, value: ValueInput): Promise<void> =>
  new Promise((resolve, reject) => {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) {
      reject(unavailable());
      return;
    }
    let encoded: string;
    try {
      encoded = `${JSON.stringify(value)}\n`;
    } catch {
      reject(unavailable());
      return;
    }
    stdin.write(encoded, (error) => (error ? reject(unavailable()) : resolve()));
  });

const openRpcSession = async (
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMillis: number,
): Promise<RpcSession> => {
  let child: NodeChildProcess;
  try {
    child = spawn(executable, ["app-server", "--stdio", "--strict-config"], {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw unavailable();
  }

  const pending = new Map<string, PendingResponse>();
  let observedBytes = 0;
  let diagnosticBytes = 0;
  let failed: HerdrCodexHooksError | undefined;
  let closing = false;
  const rejectPending = (error: HerdrCodexHooksError): void => {
    if (!failed) failed = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    rejectPending(unavailable());
  }
  const detach = stdout
    ? attachBoundedLineParser(stdout, {
        maxLineBytes: MAX_LINE_BYTES,
        maxQueuedBytes: MAX_OUTPUT_BYTES,
        onOverflow: () => rejectPending(unavailable()),
        onLine: (line) => {
          observedBytes += Buffer.byteLength(line, "utf8");
          if (observedBytes > MAX_OUTPUT_BYTES) {
            rejectPending(unavailable());
            return;
          }
          let value: unknown;
          try {
            // SAFETY: The parsed representation remains unknown until the strict RPC schemas below decode it.
            value = JSON.parse(line) as unknown;
          } catch {
            rejectPending(unavailable());
            return;
          }
          const success = Schema.decodeUnknownOption(RpcSuccessSchema)(value);
          const failure = Schema.decodeUnknownOption(RpcFailureSchema)(value);
          const response = Option.isSome(success)
            ? success.value
            : Option.isSome(failure)
              ? failure.value
              : undefined;
          if (!response) return;
          const waiter = pending.get(response.id);
          if (!waiter) {
            rejectPending(unavailable());
            return;
          }
          pending.delete(response.id);
          clearTimeout(waiter.timer);
          waiter.resolve(response);
        },
      })
    : () => {};
  const onDiagnostic = (chunk: Buffer | string): void => {
    diagnosticBytes += Buffer.byteLength(chunk);
    if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) rejectPending(unavailable());
  };
  stderr?.on("data", onDiagnostic);
  child.once("error", () => rejectPending(unavailable()));
  child.once("close", () => {
    if (!closing) rejectPending(unavailable());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      if (failed) {
        reject(failed);
        return;
      }
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = () => {
        child.off("spawn", onSpawn);
        reject(unavailable());
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  } catch (error) {
    closing = true;
    detach();
    stderr?.off("data", onDiagnostic);
    try {
      await terminateProcessTree(child, "force");
    } catch {
      throw cleanupUnconfirmed();
    }
    throw error;
  }

  const call = async (
    id: string,
    method: string,
    params: Schema.MutableJson,
  ): Promise<RpcResponse> => {
    if (failed) throw failed;
    if (pending.has(id)) throw unavailable();
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = unavailable();
        rejectPending(error);
        reject(error);
      }, timeoutMillis);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
    });
    try {
      await writeFrame(child, { id, method, params });
    } catch {
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        clearTimeout(waiter.timer);
      }
      throw unavailable();
    }
    return response;
  };

  return {
    call,
    notify: (method, params) => writeFrame(child, { method, params }),
    close: async () => {
      if (closing) return;
      closing = true;
      detach();
      stderr?.off("data", onDiagnostic);
      rejectPending(unavailable());
      child.stdin?.end();
      try {
        await terminateProcessTree(child, "force");
      } catch {
        throw cleanupUnconfirmed();
      }
    },
  };
};

const successResult = (id: string, value: RpcResponse): Schema.MutableJson => {
  const failure = Schema.decodeUnknownOption(RpcFailureSchema)(value);
  if (Option.isSome(failure)) throw unavailable();
  const success = Schema.decodeUnknownOption(RpcSuccessSchema)(value);
  if (Option.isNone(success) || success.value.id !== id) throw unavailable();
  return success.value.result;
};

const canonicalPath = async (path: string): Promise<string> => {
  try {
    return await fs.realpath(path);
  } catch {
    throw unavailable();
  }
};

const selectOwnedHook = async (
  value: Schema.MutableJson,
  input: {
    readonly cwd: string;
    readonly hooksPath: string;
    readonly command: string;
  },
): Promise<HookEntry> => {
  const decoded = Schema.decodeUnknownOption(HooksListResultSchema)(value);
  if (Option.isNone(decoded) || decoded.value.data.length !== 1) throw unavailable();
  const result = decoded.value.data[0]!;
  if (
    result.warnings.length > 0 ||
    result.errors.length > 0 ||
    result.hooks.length !== 1 ||
    (await canonicalPath(result.cwd)) !== (await canonicalPath(input.cwd))
  )
    throw unavailable();
  const hook = result.hooks[0]!;
  if (
    (await canonicalPath(hook.sourcePath)) !== (await canonicalPath(input.hooksPath)) ||
    hook.command !== input.command ||
    hook.matcher !== "startup" ||
    !hook.enabled ||
    hook.isManaged
  )
    throw unavailable();
  return hook;
};

export const makeHerdrCodexHooks = (
  options: HerdrCodexHooksOptions = {},
): HerdrCodexHooksContract => {
  const fixedEnvironment = Object.freeze(
    Object.fromEntries(
      Object.entries(options.environment ?? process.env).filter(
        ([key, value]) => value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key),
      ),
    ),
  );
  const executable = options.executable ?? CODEX_EXECUTABLE;
  const timeoutMillis = options.timeoutMillis ?? CALL_TIMEOUT_MILLIS;
  return {
    establishTrust: async (input) => {
      const environment = { ...fixedEnvironment, CODEX_HOME: input.codexHome };
      const session = await openRpcSession(executable, environment, input.cwd, timeoutMillis);
      let failure: unknown;
      try {
        successResult(
          "initialize",
          await session.call("initialize", "initialize", {
            clientInfo: { name: "pi-subagents", title: "pi-subagents", version: "1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          }),
        );
        await session.notify("initialized", {});
        const before = await selectOwnedHook(
          successResult(
            "hooks-before",
            await session.call("hooks-before", "hooks/list", { cwds: [input.cwd] }),
          ),
          input,
        );
        if (before.trustStatus !== "untrusted") throw unavailable();
        const trustResult = successResult(
          "trust",
          await session.call("trust", "config/batchWrite", {
            edits: [
              {
                keyPath: "hooks.state",
                value: { [before.key]: { trusted_hash: before.currentHash } },
                mergeStrategy: "upsert",
              },
            ],
            filePath: null,
            expectedVersion: null,
            reloadUserConfig: true,
          }),
        );
        const write = Schema.decodeUnknownOption(ConfigWriteResultSchema)(trustResult);
        if (
          Option.isNone(write) ||
          write.value.status !== "ok" ||
          write.value.overriddenMetadata !== null ||
          (await canonicalPath(write.value.filePath)) !== (await canonicalPath(input.configPath))
        )
          throw unavailable();
        const after = await selectOwnedHook(
          successResult(
            "hooks-after",
            await session.call("hooks-after", "hooks/list", { cwds: [input.cwd] }),
          ),
          input,
        );
        if (
          after.key !== before.key ||
          after.currentHash !== before.currentHash ||
          after.trustStatus !== "trusted"
        )
          throw unavailable();
      } catch (error) {
        failure = error;
      }
      try {
        await session.close();
      } catch (error) {
        throw isHerdrCodexHooksError(error) ? error : cleanupUnconfirmed();
      }
      if (failure !== undefined) throw isHerdrCodexHooksError(failure) ? failure : unavailable();
    },
  };
};
