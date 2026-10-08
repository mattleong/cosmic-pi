import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { sha256Text } from "../security/sha256.ts";
import { synchronousRandomHex } from "./native-crypto.ts";
import { nodeFsConstants as flags, nodeLockFs as fs, nodePath as path } from "./node-builtins.ts";
import { signalProcess } from "./process-tree.ts";

export class CrossProcessLockError extends Schema.TaggedError<CrossProcessLockError>()(
  "CrossProcessLockError",
  {
    reason: Schema.Literals(["unavailable", "recovery-required"]),
    /** For recovery-required at admission: the directory that needs manual recovery. */
    slot: Schema.optionalKey(Schema.String),
  },
) {}

/** Native completion callbacks are capabilities of this exact owner, not lock paths. */
export interface CrossProcessLease {
  /** Persist before entering an irreversible native operation. Throws on lost ownership. */
  readonly mutationStarted: () => void;
  /** Invoke only once the actual native Promise settles, never on abort/timeout. */
  readonly mutationSettled: () => void;
  /** Retains pending mutation evidence; late settlement releases this exact owner. */
  readonly release: () => void;
}
export interface CrossProcessLockContract {
  /**
   * One synchronous admission attempt with no polling. A dead quiescent owner is retired and
   * retried once, so `undefined` means a live owner holds the slot. The caller owns release.
   */
  readonly tryAcquire: (
    namespace: string,
  ) => Effect.Effect<CrossProcessLease | undefined, CrossProcessLockError>;
}
interface CrossProcessLockOptions {
  /** The caller's private root (mode 0700, same uid); exclusion covers only callers sharing it. */
  readonly directory: string;
}

const Owner = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  phase: Schema.Literals(["quiescent", "native-pending"]),
});
type Owner = typeof Owner.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Owner));
const encode = Schema.encodeSync(Schema.fromJsonString(Owner));
const randomToken = () => synchronousRandomHex(32);
const recovery = (slot?: string) =>
  new CrossProcessLockError({ reason: "recovery-required", ...(slot !== undefined && { slot }) });
const code = (...expected: string[]) =>
  Schema.is(Schema.Struct({ code: Schema.Literals(expected) }));
/** `slot` names the directory an admission-time recovery error is about. */
const uid = (slot?: string) => {
  if (!process.getuid) throw recovery(slot);
  return process.getuid();
};
const privateDirectory = (directory: string, slot?: string) => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid(slot) || stat.mode & 0o077)
    throw recovery(slot);
};
const syncDirectory = (directory: string) => {
  const fd = fs.openSync(directory, flags.O_RDONLY | flags.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const readOwner = (directory: string): Owner => {
  privateDirectory(directory);
  const fd = fs.openSync(path.join(directory, "owner.json"), flags.O_RDONLY | flags.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== uid() ||
      stat.mode & 0o077 ||
      stat.size > 1024 ||
      stat.nlink !== 1
    )
      throw recovery();
    return decode(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
};
const writeOwner = (directory: string, owner: Owner) => {
  const temporary = path.join(directory, `pending-${randomToken()}`);
  const fd = fs.openSync(
    temporary,
    flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, encode(owner), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, path.join(directory, "owner.json"));
  syncDirectory(directory);
};
const dead = (pid: number) => signalProcess(pid, 0) === "absent";
/** Nonempty token tombstones must remain: they prevent stale reclaimers moving a successor. */
const retire = (directory: string, owner: Owner, root: string) => {
  const current = readOwner(directory);
  if (current.token !== owner.token || current.phase !== "quiescent") throw recovery();
  fs.renameSync(directory, `${directory}.retired-${owner.token}`);
  syncDirectory(root);
};

/** Only normal-release evidence created by this exact live owner can be removed. */
const cleanReleased = (directory: string, owner: Owner) => {
  try {
    const current = readOwner(directory);
    if (current.token !== owner.token || current.pid !== owner.pid || current.phase !== "quiescent")
      return;
    const names = fs.readdirSync(directory);
    if (names.length !== 1 || names[0] !== "owner.json") return;
    fs.unlinkSync(path.join(directory, "owner.json"));
    fs.rmdirSync(directory);
  } catch {
    // A partial cleanup is retained for offline inspection. Never retry via the public slot.
  }
};

/**
 * Synchronous, bounded filesystem commits keep ownership handoff free of cancellation gaps.
 * With `retryAfterRetire`, one attempt follows retiring a dead quiescent owner, so
 * `undefined` then means another owner holds the slot.
 */
export const acquireNativeLock = (
  namespace: string,
  options: CrossProcessLockOptions,
  retryAfterRetire = false,
): CrossProcessLease | undefined => {
  const root = options.directory;
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (!code("EEXIST")(error)) throw error;
  }
  privateDirectory(root, root);
  const directory = path.join(root, sha256Text(namespace));
  let previous: Owner | undefined;
  try {
    previous = readOwner(directory);
  } catch (error) {
    if (!code("ENOENT")(error)) throw recovery(directory);
    // Only absence is available. An existing directory with no owner is corrupt, not stale.
    try {
      fs.lstatSync(directory);
      throw recovery(directory);
    } catch (statError) {
      if (!code("ENOENT")(statError)) throw statError;
    }
  }
  if (previous) {
    if (!dead(previous.pid)) return undefined;
    // PID death proves the JS owner stopped, not that a native service finished a mutation.
    if (previous.phase === "native-pending") throw recovery(directory);
    try {
      retire(directory, previous, root);
    } catch (retireError) {
      if (!code("ENOENT", "ENOTEMPTY", "EEXIST")(retireError)) throw retireError;
    }
    return retryAfterRetire ? acquireNativeLock(namespace, options) : undefined;
  }
  const owner: Owner = { version: 1, token: randomToken(), pid: process.pid, phase: "quiescent" };
  const candidate = path.join(root, `.candidate-${owner.token}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  // Build and fsync complete nonempty evidence before making the reservation visible.
  // A crash here leaves only an unreferenced candidate, never an empty public slot.
  writeOwner(candidate, owner);
  try {
    fs.renameSync(candidate, directory);
  } catch (error) {
    fs.unlinkSync(path.join(candidate, "owner.json"));
    fs.rmdirSync(candidate);
    if (code("EEXIST", "ENOTEMPTY")(error)) return undefined;
    throw error;
  }
  try {
    syncDirectory(root);
  } catch (error) {
    // No native work was admitted. Do not strand a live-PID owner when publication
    // succeeded but its durability check failed before handing the lease to Effect.
    try {
      retire(directory, owner, root);
    } catch {
      throw recovery();
    }
    throw error;
  }
  let pending = false;
  let releaseRequested = false;
  let released = false;
  let uncertain = false;
  const uncertainOnFailure = (commit: () => void) => {
    try {
      commit();
    } catch (error) {
      uncertain = true;
      throw error;
    }
  };
  const check = () => {
    if (released || uncertain || readOwner(directory).token !== owner.token) throw recovery();
  };
  const release = () => {
    releaseRequested = true;
    if (released || pending || uncertain) return;
    check();
    const destination = `${directory}.released-${owner.token}`;
    // A dead reclaimer observes PID death BEFORE its final exact-token check.
    // It cannot pass that check for this live owner. Old reclaimers targeting a
    // predecessor remain fenced by that predecessor's permanent nonempty retired path.
    uncertainOnFailure(() => fs.renameSync(directory, destination));
    // Relinquishment is final even if durability or owned cleanup fails afterward.
    released = true;
    syncDirectory(root);
    cleanReleased(destination, owner);
  };
  return {
    mutationStarted: () => {
      check();
      if (pending || releaseRequested) throw recovery();
      pending = true;
      uncertainOnFailure(() => writeOwner(directory, { ...owner, phase: "native-pending" }));
    },
    mutationSettled: () => {
      check();
      if (!pending) throw recovery();
      uncertainOnFailure(() => writeOwner(directory, owner));
      pending = false;
      if (releaseRequested) release();
    },
    release,
  };
};

const failure = (cause: unknown) =>
  cause instanceof CrossProcessLockError
    ? cause
    : new CrossProcessLockError({ reason: "unavailable" });

/** Opt-in same-host coordination. No stale-time or heartbeat stealing. */
export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockContract>()(
  "pi-cosmic-core/platform/cross-process-lock/CrossProcessLock",
) {
  static readonly layer = (options: CrossProcessLockOptions) =>
    Layer.succeed(this, {
      tryAcquire: (namespace) =>
        Effect.try({ try: () => acquireNativeLock(namespace, options, true), catch: failure }),
    });
}
