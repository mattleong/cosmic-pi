import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  currentProcessIdentity,
  probeProcessLiveness,
  type ProcessIdentity,
  type ProcessLiveness,
} from "pi-cosmic-core/platform/process-start";
import { nodeFsPromises as fs, nodePath } from "pi-cosmic-core/platform/node-builtins";
import {
  type PrivateFileError,
  removeOwnEntry,
  removePrivateTree,
  replacePrivateFile,
} from "pi-cosmic-core/platform/private-file";
import { synchronousRandomHex } from "pi-cosmic-core/platform/native-crypto";
import { safeAgentDirectory } from "./harness-shared.ts";

/** Private state nobody has touched for this long is abandoned unless a recorded owner may be live. */
export const PRIVATE_STATE_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;

export const SUBAGENT_STATE_ROOT = "subagents";
export const REPORT_ARCHIVE_ROOT = "reports";
export const LOCAL_CLI_HARNESS_ROOT = "local-cli-v1";
export const SUPERVISOR_CHANNEL_ROOT = "supervisor-channels-v3";
export const WRITER_LEASE_ROOT = "writer-leases-v3";
export const LOCAL_CLAUDE_DEBUG_ROOT = "local-claude-debug-v1";

/**
 * Claude children's private temp roots live directly under `/tmp`: Claude Code gives sandboxed
 * Bash its `<root>/claude-<uid>` directory only while that path fits in 44 bytes.
 */
export const CLAUDE_TEMPORARY_PARENT = "/tmp";
export const CLAUDE_TEMPORARY_PREFIX = "pi-claude-";
const CLAUDE_TEMPORARY_NAME = /^pi-claude-[A-Za-z0-9]{6}$/u;
const CLAUDE_TEMPORARY_TOMBSTONE = /^\.swept-pi-claude-[A-Za-z0-9]{6}-[0-9a-f]{12}$/u;

const OWNED_ENTRY_ROOTS = [LOCAL_CLI_HARNESS_ROOT, SUPERVISOR_CHANNEL_ROOT] as const;
const NAMED_ROOTS: ReadonlySet<string> = new Set([
  ...OWNED_ENTRY_ROOTS,
  REPORT_ARCHIVE_ROOT,
  WRITER_LEASE_ROOT,
  LOCAL_CLAUDE_DEBUG_ROOT,
]);
const RUN_DIRECTORY_PREFIX = "agent-";
const TOMBSTONE_PREFIX = ".swept-";
const PRIVATE_STATE_OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 1024;

const PrivateStateOwner = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  started: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
const decodeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(PrivateStateOwner));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(PrivateStateOwner));

/**
 * Records this process as the owner of a private state directory, so a later Pi can remove the
 * directory as soon as this process is gone instead of waiting for it to age out.
 */
export const recordPrivateStateOwner = (directory: string): Effect.Effect<void, PrivateFileError> =>
  Effect.suspend(() => {
    const { pid, started } = currentProcessIdentity();
    const source = encodeOwner({ version: 1, pid, ...(started !== undefined && { started }) });
    const target = nodePath.join(directory, PRIVATE_STATE_OWNER_FILE);
    return replacePrivateFile(target, `${target}.${synchronousRandomHex(6)}.tmp`, source);
  });

/** Removes the owner record so callers that require an empty directory can remove it. */
export const removePrivateStateOwner = (directory: string): Effect.Effect<void, PrivateFileError> =>
  removeOwnEntry(nodePath.join(directory, PRIVATE_STATE_OWNER_FILE));

const io = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<Option.Option<A>> =>
  Effect.tryPromise(evaluate).pipe(Effect.option);

const readOwner = (directory: string): Effect.Effect<Option.Option<ProcessIdentity>> => {
  const file = nodePath.join(directory, PRIVATE_STATE_OWNER_FILE);
  return io(() =>
    fs
      .lstat(file)
      .then((stat) =>
        stat.isFile() && stat.size <= MAX_OWNER_BYTES ? fs.readFile(file, "utf8") : "",
      ),
  ).pipe(Effect.map(Option.flatMap(decodeOwner)));
};

const newestModification = (directory: string): Effect.Effect<Option.Option<number>> =>
  io(() =>
    fs.lstat(directory).then((stat) =>
      fs.readdir(directory).then((names) =>
        Promise.all(
          Arr.map(names, (name) =>
            fs.lstat(nodePath.join(directory, name)).then(
              (entry) => entry.mtimeMs,
              () => 0,
            ),
          ),
        ).then((times) => Math.max(stat.mtimeMs, ...times)),
      ),
    ),
  );

interface SweepContext {
  readonly now: number;
  readonly liveness: Map<string, ProcessLiveness>;
}

const ownerLiveness = (
  context: SweepContext,
  owner: ProcessIdentity,
): Effect.Effect<ProcessLiveness> => {
  const key = `${owner.pid}:${owner.started ?? ""}`;
  const cached = context.liveness.get(key);
  if (cached) return Effect.succeed(cached);
  return probeProcessLiveness(owner).pipe(
    Effect.tap((liveness) => Effect.sync(() => context.liveness.set(key, liveness))),
  );
};

/**
 * Abandoned when its owner is provably gone, or, without a readable owner record, when stale. An
 * owner whose liveness can't be decided, such as one recorded in another identity format, may be
 * a live session, so its state is never aged out.
 */
const isAbandoned = Effect.fnUntraced(function* (
  context: SweepContext,
  directory: string,
): Effect.fn.Return<boolean> {
  const owner = yield* readOwner(directory);
  if (Option.isSome(owner)) return (yield* ownerLiveness(context, owner.value)) === "dead";
  const modified = yield* newestModification(directory);
  return Option.isSome(modified) && context.now - modified.value > PRIVATE_STATE_RETENTION_MILLIS;
});

/**
 * Renames the entry to a tombstone first, so a concurrent Pi never finds it half deleted and a
 * deletion interrupted by a crash is finished by the next sweep.
 */
const removeEntry = (parent: string, name: string): Effect.Effect<boolean> => {
  const tombstone = nodePath.join(parent, `${TOMBSTONE_PREFIX}${name}-${synchronousRandomHex(6)}`);
  return io(() => fs.rename(nodePath.join(parent, name), tombstone)).pipe(
    Effect.flatMap((renamed) =>
      Option.isNone(renamed)
        ? Effect.succeed(false)
        : removePrivateTree(tombstone).pipe(Effect.option, Effect.as(true)),
    ),
  );
};

const isRealDirectory = (path: string): Effect.Effect<boolean> =>
  io(() => fs.lstat(path)).pipe(
    Effect.map(Option.exists((stat) => stat.isDirectory() && !stat.isSymbolicLink())),
  );

const isOwnedRealDirectory = (path: string, uid: number): Effect.Effect<boolean> =>
  io(() => fs.lstat(path)).pipe(
    Effect.map(
      Option.exists((stat) => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid),
    ),
  );

const directoryEntries = (directory: string) =>
  io(() => fs.readdir(directory, { withFileTypes: true })).pipe(
    Effect.map(Option.getOrElse(() => [])),
  );

interface SweepPolicy {
  readonly isCandidate: (name: string) => boolean;
  readonly isTombstone: (name: string) => boolean;
  /** In a directory other users can write, only real directories this user owns are touched. */
  readonly ownerUid?: number | undefined;
}

const PRIVATE_ROOT_POLICY: SweepPolicy = {
  isCandidate: () => true,
  isTombstone: (name) => Fn.pipe(name, Str.startsWith(TOMBSTONE_PREFIX)),
};

/** Sweeps one directory's entries; returns how many it removed. */
const sweepEntries = Effect.fn("PrivateState.sweepEntries")(function* (
  context: SweepContext,
  parent: string,
  policy: SweepPolicy,
): Effect.fn.Return<number> {
  let removed = 0;
  for (const entry of yield* directoryEntries(parent)) {
    const tombstone = policy.isTombstone(entry.name);
    if (!tombstone && (!entry.isDirectory() || !policy.isCandidate(entry.name))) continue;
    const path = nodePath.join(parent, entry.name);
    if (policy.ownerUid !== undefined && !(yield* isOwnedRealDirectory(path, policy.ownerUid)))
      continue;
    if (tombstone) {
      yield* Effect.option(removePrivateTree(path));
      removed += 1;
      continue;
    }
    if (!(yield* isAbandoned(context, path))) continue;
    if (yield* removeEntry(parent, entry.name)) removed += 1;
  }
  return removed;
});

/** Claude temp roots share `/tmp` with every user, so only this user's real directories qualify. */
const sweepClaudeTemporaryRoots = (context: SweepContext, parent: string): Effect.Effect<void> => {
  const uid = process.getuid?.();
  return uid === undefined
    ? Effect.void
    : sweepEntries(context, parent, {
        isCandidate: (name) => CLAUDE_TEMPORARY_NAME.test(name),
        isTombstone: (name) => CLAUDE_TEMPORARY_TOMBSTONE.test(name),
        ownerUid: uid,
      }).pipe(Effect.asVoid);
};

interface PrivateStateSweepOptions {
  readonly claudeTemporaryParent?: string | undefined;
}

/**
 * Removes private run state that crashed or killed Pi sessions left behind: local Pi run
 * directories under `subagents/<session>/`, local CLI harnesses, supervisor channel state, and
 * Claude children's temp roots under `/tmp`. Reports, writer leases, debug ledgers, and writer
 * workspaces have their own owners and are never touched. Every entry failure is ignored.
 */
export const sweepAbandonedPrivateState = Effect.fn("PrivateState.sweepAbandonedPrivateState")(
  function* (
    agentDirectory: string,
    options: PrivateStateSweepOptions = {},
  ): Effect.fn.Return<void> {
    const context: SweepContext = { now: yield* Clock.currentTimeMillis, liveness: new Map() };
    yield* sweepClaudeTemporaryRoots(
      context,
      options.claudeTemporaryParent ?? CLAUDE_TEMPORARY_PARENT,
    );
    const canonical = yield* Effect.option(safeAgentDirectory(agentDirectory));
    if (Option.isNone(canonical)) return;
    const root = nodePath.join(canonical.value, SUBAGENT_STATE_ROOT);
    if (!(yield* isRealDirectory(root))) return;
    for (const name of OWNED_ENTRY_ROOTS) {
      const owned = nodePath.join(root, name);
      if (yield* isRealDirectory(owned)) yield* sweepEntries(context, owned, PRIVATE_ROOT_POLICY);
    }
    for (const entry of yield* directoryEntries(root)) {
      if (
        !entry.isDirectory() ||
        Fn.pipe(entry.name, Str.startsWith(".")) ||
        NAMED_ROOTS.has(entry.name)
      )
        continue;
      const session = nodePath.join(root, entry.name);
      yield* sweepEntries(context, session, {
        ...PRIVATE_ROOT_POLICY,
        isCandidate: (name) => Fn.pipe(name, Str.startsWith(RUN_DIRECTORY_PREFIX)),
      });
      // Removes the session directory only once it is empty, including one an interrupted spawn's
      // late cleanup had to leave because it couldn't prove it created the directory.
      yield* io(() => fs.rmdir(session));
    }
  },
);
