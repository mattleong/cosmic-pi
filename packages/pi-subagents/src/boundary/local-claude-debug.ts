// Opt-in, metadata-only Claude protocol ledger. It retains no message text,
// UUIDs, session IDs, paths, tool inputs, or raw foreign frames. The bounded
// tail is written to private agent state only when the owning scope closes.
import { createHash, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";
import { ensurePrivateDirectory, safeAgentDirectory, writeExclusive } from "./harness-shared.ts";

const { join } = nodePath;

const DEBUG_ROOT = "local-claude-debug-v1";
const LEDGER_FILE = "replay-ledger.ndjson";
const MAX_LEDGER_BYTES = 64 * 1024;
const MAX_LEDGER_ENTRIES = 512;
const MAX_RETAINED_LEDGERS = 8;
const MAX_LINE_BYTES = 2 * 1024;
// Independently built local-CLI Layers share one debug-retention directory.
// This process-local lock keeps pruning plus publication one bounded commit.
const persistenceLock = Semaphore.makeUnsafe(1);

export type LocalClaudeDebugEntry =
  | {
      readonly kind: "outbound-user";
      readonly sequence: number;
      readonly operation: "initialize" | "start" | "steer";
      readonly epoch: number;
      readonly shouldQuery: boolean;
    }
  | {
      readonly kind: "inbound";
      readonly sequence: number;
      readonly protocolType:
        | "init"
        | "user"
        | "assistant"
        | "activity"
        | "result"
        | "control_response"
        | "ignored";
      readonly epoch: number;
    }
  | {
      readonly kind: "user-decision";
      readonly sequence: number;
      readonly decision:
        | "pending-confirmation"
        | "interrupt-marker"
        | "native-forward"
        | "synthetic-subturn"
        | "queued-task-notification"
        | "known-internal-replay"
        | "tool-results"
        | "known-replay"
        | "unknown-before-report"
        | "unknown-after-report";
      readonly epoch: number;
      readonly replay: boolean;
      readonly synthetic: boolean;
      readonly meta: boolean;
      readonly compact: boolean;
      readonly session: "absent" | "uninitialized" | "match" | "mismatch";
      readonly uuid: "absent" | "pending" | "known" | "internal" | "unknown";
      readonly content: "probe" | "assignment" | "steer" | "multiple" | "other";
      readonly contentForm: "text" | "blocks";
      readonly length: "empty" | "1-64" | "65-1024" | "1025-16384" | "over-16384";
      readonly tag:
        | "none"
        | "other"
        | "task-notification"
        | "system-reminder"
        | "teammate-message"
        | "local-command-stdout"
        | "local-command-stderr"
        | "local-command-caveat";
      readonly parentTool: boolean;
      readonly toolResults: boolean;
      readonly origin: boolean;
      readonly subkind: boolean;
      readonly pending: "initialize" | "start" | "steer" | "interrupt" | "none";
      readonly report: "accepted" | "none" | "unknown";
    };

export interface LocalClaudeDebugRecorder {
  readonly record: (entry: LocalClaudeDebugEntry) => Effect.Effect<void>;
}

interface LedgerState {
  readonly lines: string[];
  bytes: number;
  dropped: number;
}

export const localClaudeDebugEnabled = (environment: NodeJS.ProcessEnv): boolean =>
  environment.PI_SUBAGENTS_CLAUDE_DEBUG === "1";

const safeInteger = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

const encodeEntry = (entry: LocalClaudeDebugEntry): string => {
  const normalized = {
    ...entry,
    sequence: safeInteger(entry.sequence),
    epoch: safeInteger(entry.epoch),
  };
  const line = `${JSON.stringify(normalized)}\n`;
  return Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES ? line : "";
};

const appendBounded = (state: LedgerState, line: string): void => {
  if (!line) {
    state.dropped += 1;
    return;
  }
  const bytes = Buffer.byteLength(line, "utf8");
  state.lines.push(line);
  state.bytes += bytes;
  while (state.lines.length > MAX_LEDGER_ENTRIES || state.bytes > MAX_LEDGER_BYTES) {
    const removed = state.lines.shift();
    if (!removed) break;
    state.bytes -= Buffer.byteLength(removed, "utf8");
    state.dropped += 1;
  }
};

class LocalClaudeDebugIoError extends Schema.TaggedError<LocalClaudeDebugIoError>()(
  "LocalClaudeDebugIoError",
  {},
) {}

const diagnosticIo = <A>(
  operation: () => PromiseLike<A>,
): Effect.Effect<A, LocalClaudeDebugIoError> =>
  Effect.tryPromise({
    try: operation,
    catch: () => new LocalClaudeDebugIoError({}),
  });

interface OwnedLedgerDirectory {
  readonly directory: string;
  readonly modifiedAt: number;
}

const ownedLedgerDirectories = Effect.fn("LocalClaudeDebug.ownedLedgers")(function* (root: string) {
  const entries = yield* diagnosticIo(() => fs.readdir(root, { withFileTypes: true }));
  const candidates = entries.filter(
    (entry) => entry.name.startsWith("claude-") && entry.isDirectory() && !entry.isSymbolicLink(),
  );
  if (candidates.length > 256) return yield* new LocalClaudeDebugIoError({});
  const owned = yield* Effect.forEach(
    candidates,
    (entry) => {
      const directory = join(root, entry.name);
      return diagnosticIo(() => fs.lstat(directory)).pipe(
        Effect.map((directoryStat): OwnedLedgerDirectory | undefined =>
          directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
            ? { directory, modifiedAt: directoryStat.mtimeMs }
            : undefined,
        ),
      );
    },
    { concurrency: 16 },
  );
  return owned
    .filter((entry): entry is OwnedLedgerDirectory => Boolean(entry))
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
});

const persistLedger = Effect.fn("LocalClaudeDebug.persist")(function* (
  agentDirectory: string,
  runIdentity: string,
  state: LedgerState,
) {
  const canonicalAgentDirectory = yield* diagnosticIo(() => safeAgentDirectory(agentDirectory));
  const packageRoot = join(canonicalAgentDirectory, "subagents");
  const root = join(packageRoot, DEBUG_ROOT);
  yield* diagnosticIo(() => ensurePrivateDirectory(packageRoot));
  yield* diagnosticIo(() => ensurePrivateDirectory(root));
  const owned = yield* ownedLedgerDirectories(root);
  for (const entry of owned.slice(0, Math.max(0, owned.length - MAX_RETAINED_LEDGERS + 1)))
    yield* diagnosticIo(() => fs.rm(entry.directory, { recursive: true, force: false }));

  const directory = join(root, `claude-${runIdentity}-${randomBytes(8).toString("hex")}`);
  yield* diagnosticIo(() => fs.mkdir(directory, { mode: 0o700 }));
  const header = `{"kind":"ledger","dropped":${safeInteger(state.dropped)}}\n`;
  const available = MAX_LEDGER_BYTES - Buffer.byteLength(header, "utf8");
  const retained: string[] = [];
  let retainedBytes = 0;
  for (let index = state.lines.length - 1; index >= 0; index -= 1) {
    const line = state.lines[index];
    if (!line) continue;
    const bytes = Buffer.byteLength(line, "utf8");
    if (retainedBytes + bytes > available) break;
    retained.unshift(line);
    retainedBytes += bytes;
  }
  yield* diagnosticIo(() =>
    writeExclusive(join(directory, LEDGER_FILE), `${header}${retained.join("")}`),
  ).pipe(
    Effect.tapError(() =>
      diagnosticIo(() => fs.rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
    ),
  );
});

/**
 * Allocates a bounded in-memory ledger only under the explicit debug gate. Its
 * finalizer writes a nonempty metadata-only tail to private agent state and
 * retains at most eight owned directories. Diagnostic failure never changes run behavior.
 */
export const acquireLocalClaudeDebug = Effect.fn("LocalClaudeDebug.acquire")(function* (options: {
  readonly agentDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runId: string;
}) {
  if (!localClaudeDebugEnabled(options.environment)) return undefined;
  const lock = yield* Semaphore.make(1);
  const withLock = lock.withPermits(1);
  const state: LedgerState = { lines: [], bytes: 0, dropped: 0 };
  const runIdentity = createHash("sha256").update(options.runId, "utf8").digest("hex").slice(0, 12);
  const record = (entry: LocalClaudeDebugEntry): Effect.Effect<void> =>
    withLock(Effect.sync(() => appendBounded(state, encodeEntry(entry)))).pipe(Effect.ignoreCause);
  yield* Effect.addFinalizer(() =>
    persistenceLock.withPermits(1)(
      withLock(
        Effect.suspend(() =>
          state.lines.length === 0 && state.dropped === 0
            ? Effect.void
            : persistLedger(options.agentDirectory, runIdentity, state).pipe(Effect.ignoreCause),
        ),
      ),
    ),
  );
  return { record } satisfies LocalClaudeDebugRecorder;
});
