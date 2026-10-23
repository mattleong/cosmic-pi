import {
  createPrivateDirectory,
  createPrivateFile,
  ensurePrivateDirectory,
  nodeFsPromises as fs,
  nodePath,
  type PrivateFileError,
  removePrivateTree,
  sha256Text,
  synchronousRandomHex,
} from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ClaudeLeadingTagDiagnostic } from "../backend/local-claude-correlation.ts";
import type { ClaudeProtocolEvent } from "../backend/local-claude-protocol.ts";
import { safeAgentDirectory } from "./harness-shared.ts";
import { LOCAL_CLAUDE_DEBUG_ROOT, SUBAGENT_STATE_ROOT } from "./private-state.ts";

const LEDGER_FILE = "replay-ledger.ndjson";
const MAX_LEDGER_BYTES = 64 * 1024;
const MAX_LEDGER_ENTRIES = 512;
const MAX_RETAINED_LEDGERS = 8;
const MAX_LINE_BYTES = 2 * 1024;
const persistenceLock = Semaphore.makeUnsafe(1);

export type LocalClaudeDebugEntry =
  | {
      readonly kind: "outbound-user";
      readonly sequence: number;
      readonly operation: "initialize" | "start" | "steer" | "remind";
      readonly epoch: number;
      readonly shouldQuery: boolean;
    }
  | {
      readonly kind: "inbound";
      readonly sequence: number;
      readonly protocolType: ClaudeProtocolEvent["type"];
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
      readonly tag: ClaudeLeadingTagDiagnostic;
      readonly parentTool: boolean;
      readonly toolResults: boolean;
      readonly origin: boolean;
      readonly subkind: boolean;
      readonly pending: "initialize" | "start" | "steer" | "remind" | "interrupt" | "none";
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

const ledgerHeader = (dropped: number) => `{"kind":"ledger","dropped":${dropped}}\n`;
const MAX_TAIL_BYTES = MAX_LEDGER_BYTES - Buffer.byteLength(ledgerHeader(Number.MAX_SAFE_INTEGER));

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
  while (state.lines.length > MAX_LEDGER_ENTRIES || state.bytes > MAX_TAIL_BYTES) {
    const removed = state.lines.shift();
    if (!removed) break;
    state.bytes -= Buffer.byteLength(removed, "utf8");
    state.dropped += 1;
  }
};

class LocalClaudeDebugIoError extends Schema.TaggedError<
  LocalClaudeDebugIoError,
  { readonly brand: unique symbol }
>()("LocalClaudeDebugIoError", {}) {}

const diagnosticIo = <A>(
  operation: () => PromiseLike<A>,
): Effect.Effect<A, LocalClaudeDebugIoError> =>
  Effect.tryPromise({
    try: operation,
    catch: () => new LocalClaudeDebugIoError({}),
  });

const diagnosticStep = <A>(
  effect: Effect.Effect<A, PrivateFileError>,
): Effect.Effect<A, LocalClaudeDebugIoError> =>
  effect.pipe(Effect.mapError(() => new LocalClaudeDebugIoError({})));

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
      const directory = nodePath.join(root, entry.name);
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
    .toSorted((left, right) => left.modifiedAt - right.modifiedAt);
});

const persistLedger = Effect.fn("LocalClaudeDebug.persist")(function* (
  agentDirectory: string,
  runIdentity: string,
  ledger: string,
) {
  const canonicalAgentDirectory = yield* diagnosticStep(safeAgentDirectory(agentDirectory));
  const packageRoot = nodePath.join(canonicalAgentDirectory, SUBAGENT_STATE_ROOT);
  const root = nodePath.join(packageRoot, LOCAL_CLAUDE_DEBUG_ROOT);
  yield* diagnosticStep(ensurePrivateDirectory(packageRoot));
  yield* diagnosticStep(ensurePrivateDirectory(root));
  const owned = yield* ownedLedgerDirectories(root);
  for (const entry of owned.slice(0, Math.max(0, owned.length - MAX_RETAINED_LEDGERS + 1)))
    yield* diagnosticIo(() => fs.rm(entry.directory, { recursive: true, force: false }));

  const directory = nodePath.join(root, `claude-${runIdentity}-${synchronousRandomHex(8)}`);
  yield* diagnosticStep(createPrivateDirectory(directory));
  yield* diagnosticStep(createPrivateFile(nodePath.join(directory, LEDGER_FILE), ledger)).pipe(
    Effect.tapError(() => Effect.ignore(removePrivateTree(directory))),
  );
});

export const acquireLocalClaudeDebug = Effect.fn("LocalClaudeDebug.acquire")(function* (options: {
  readonly agentDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runId: string;
}) {
  if (options.environment.PI_SUBAGENTS_CLAUDE_DEBUG !== "1") return undefined;
  const state: LedgerState = { lines: [], bytes: 0, dropped: 0 };
  const runIdentity = sha256Text(options.runId).slice(0, 12);
  const record = (entry: LocalClaudeDebugEntry): Effect.Effect<void> =>
    Effect.sync(() => appendBounded(state, encodeEntry(entry))).pipe(Effect.ignoreCause);
  yield* Effect.addFinalizer(() =>
    persistenceLock.withPermits(1)(
      Effect.suspend(() =>
        state.lines.length === 0 && state.dropped === 0
          ? Effect.void
          : persistLedger(
              options.agentDirectory,
              runIdentity,
              ledgerHeader(safeInteger(state.dropped)) + state.lines.join(""),
            ).pipe(Effect.ignoreCause),
      ),
    ),
  );
  return { record } satisfies LocalClaudeDebugRecorder;
});
