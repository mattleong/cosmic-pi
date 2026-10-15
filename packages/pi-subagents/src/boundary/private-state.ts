import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  currentProcessIdentity,
  processLiveness,
  type ProcessIdentity,
  type ProcessLiveness,
  synchronousRandomHex,
} from "pi-cosmic-core";
import { removePrivateTree, safeAgentDirectory } from "./harness-shared.ts";
import { nodeFsConstants as constants, nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

/** Private state nobody has touched for this long is abandoned, whoever owned it. */
export const PRIVATE_STATE_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;

export const SUBAGENT_STATE_ROOT = "subagents";
export const REPORT_ARCHIVE_ROOT = "reports";
export const LOCAL_CLI_HARNESS_ROOT = "local-cli-v1";
export const CODEX_CATALOG_HARNESS_ROOT = "native-model-catalog-v1";
export const SUPERVISOR_CHANNEL_ROOT = "supervisor-channels-v3";
export const WRITER_LEASE_ROOT = "writer-leases-v3";
export const LOCAL_CLAUDE_DEBUG_ROOT = "local-claude-debug-v1";

const OWNED_ENTRY_ROOTS = [
  LOCAL_CLI_HARNESS_ROOT,
  CODEX_CATALOG_HARNESS_ROOT,
  SUPERVISOR_CHANNEL_ROOT,
] as const;
const NAMED_ROOTS: ReadonlySet<string> = new Set([
  ...OWNED_ENTRY_ROOTS,
  REPORT_ARCHIVE_ROOT,
  WRITER_LEASE_ROOT,
  LOCAL_CLAUDE_DEBUG_ROOT,
]);
const RUN_DIRECTORY_PREFIX = "agent-";
const TOMBSTONE_PREFIX = ".swept-";
export const PRIVATE_STATE_OWNER_FILE = "owner.json";
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
export const recordPrivateStateOwner = (directory: string): Promise<void> => {
  const { pid, started } = currentProcessIdentity();
  const source = encodeOwner({ version: 1, pid, ...(started !== undefined && { started }) });
  return fs
    .open(
      nodePath.join(directory, PRIVATE_STATE_OWNER_FILE),
      constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    .then((handle) =>
      handle.writeFile(source, { encoding: "utf8" }).then(
        () => handle.close(),
        (cause: unknown) =>
          handle.close().then(() => {
            throw cause;
          }),
      ),
    );
};

/** Removes the owner record so callers that require an empty directory can remove it. */
export const removePrivateStateOwner = (directory: string): Promise<void> =>
  fs.rm(nodePath.join(directory, PRIVATE_STATE_OWNER_FILE), { force: true });

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
          names.map((name) =>
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

const ownerLiveness = (context: SweepContext, owner: ProcessIdentity): ProcessLiveness => {
  const key = `${owner.pid}:${owner.started ?? ""}`;
  const cached = context.liveness.get(key);
  if (cached) return cached;
  const liveness = processLiveness(owner);
  context.liveness.set(key, liveness);
  return liveness;
};

/** Abandoned when its owner is provably gone, or, without a provably live owner, when stale. */
const isAbandoned = (context: SweepContext, directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const owner = yield* readOwner(directory);
    const liveness = Option.isSome(owner) ? ownerLiveness(context, owner.value) : "unknown";
    if (liveness !== "unknown") return liveness === "dead";
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
        : io(() => removePrivateTree(tombstone)).pipe(Effect.as(true)),
    ),
  );
};

const isRealDirectory = (path: string): Effect.Effect<boolean> =>
  io(() => fs.lstat(path)).pipe(
    Effect.map(Option.exists((stat) => stat.isDirectory() && !stat.isSymbolicLink())),
  );

const directoryEntries = (directory: string) =>
  io(() => fs.readdir(directory, { withFileTypes: true })).pipe(
    Effect.map(Option.getOrElse(() => [])),
  );

/** Sweeps one directory's entries; returns how many it removed. */
const sweepEntries = (
  context: SweepContext,
  parent: string,
  isCandidate: (name: string) => boolean,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    let removed = 0;
    for (const entry of yield* directoryEntries(parent)) {
      if (entry.name.startsWith(TOMBSTONE_PREFIX)) {
        yield* io(() => removePrivateTree(nodePath.join(parent, entry.name)));
        removed += 1;
        continue;
      }
      if (!entry.isDirectory() || !isCandidate(entry.name)) continue;
      if (!(yield* isAbandoned(context, nodePath.join(parent, entry.name)))) continue;
      if (yield* removeEntry(parent, entry.name)) removed += 1;
    }
    return removed;
  });

/**
 * Removes private run state that crashed or killed Pi sessions left behind: local Pi run
 * directories under `subagents/<session>/`, local CLI harnesses (which can hold a copied Codex
 * credential), and supervisor channel state. Reports, writer leases, debug ledgers, and writer
 * workspaces have their own owners and are never touched. Every entry failure is ignored.
 */
export const sweepAbandonedPrivateState = (agentDirectory: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const canonical = yield* io(() => safeAgentDirectory(agentDirectory));
    if (Option.isNone(canonical)) return;
    const root = nodePath.join(canonical.value, SUBAGENT_STATE_ROOT);
    if (!(yield* isRealDirectory(root))) return;
    const context: SweepContext = { now: yield* Clock.currentTimeMillis, liveness: new Map() };
    for (const name of OWNED_ENTRY_ROOTS) {
      const owned = nodePath.join(root, name);
      if (yield* isRealDirectory(owned)) yield* sweepEntries(context, owned, () => true);
    }
    for (const entry of yield* directoryEntries(root)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || NAMED_ROOTS.has(entry.name))
        continue;
      const session = nodePath.join(root, entry.name);
      const removed = yield* sweepEntries(context, session, (name) =>
        name.startsWith(RUN_DIRECTORY_PREFIX),
      );
      if (removed > 0) yield* io(() => fs.rmdir(session));
    }
  });
