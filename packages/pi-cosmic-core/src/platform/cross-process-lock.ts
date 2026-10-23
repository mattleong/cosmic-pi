import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { sha256Text } from "../security/sha256.ts";
import { synchronousRandomHex } from "./native-crypto.ts";
import { nodeFsConstants as flags, nodeLockFs as fs, nodePath as path } from "./node-builtins.ts";
import { hasPrivateMode, isOwnedByCurrentUser, isPrivateDirectoryInfo } from "./private-file.ts";
import { currentProcessIdentity, processLiveness, type ProcessIdentity } from "./process-start.ts";

export class CrossProcessLockError extends Schema.TaggedError<
  CrossProcessLockError,
  { readonly brand: unique symbol }
>()("CrossProcessLockError", {
  reason: Schema.Literals(["unavailable", "recovery-required"]),
  slot: Schema.optionalKey(Schema.String),
}) {}

export interface CrossProcessLease {
  readonly mutationStarted: () => void;
  readonly mutationSettled: () => void;
  readonly release: () => void;
}
export interface CrossProcessLockContract {
  /**
   * Waits for the acquisition's fsyncs on the libuv thread pool and can't be interrupted, so a
   * caller that must not lose the lease acquires it in an uninterruptible region.
   */
  readonly tryAcquire: (
    namespace: string,
  ) => Effect.Effect<CrossProcessLease | undefined, CrossProcessLockError>;
}
interface CrossProcessLockOptions {
  readonly directory: string;
}

const Owner = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  /** The owner's start identity, when known, so a reused PID doesn't keep the lease alive. */
  started: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  phase: Schema.Literals(["quiescent", "native-pending"]),
});
type Owner = typeof Owner.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Owner));
const encode = Schema.encodeSync(Schema.fromJsonString(Owner));
const randomToken = () => synchronousRandomHex(32);
const recovery = (slot?: string) =>
  CrossProcessLockError.make({ reason: "recovery-required", ...(slot !== undefined && { slot }) });
const code = (...expected: string[]) =>
  Schema.is(Schema.Struct({ code: Schema.Literals(expected) }));
const isExists = code("EEXIST");
const isMissing = code("ENOENT");
const isRetireRace = code("ENOENT", "ENOTEMPTY", "EEXIST");
const isSlotOccupied = code("EEXIST", "ENOTEMPTY");

/**
 * The lock protocol is written once as steps that yield each open descriptor whose contents must
 * be durable before the protocol continues. Lease callbacks such as `release` are synchronous, so
 * their driver fsyncs inline; acquisition and document-lock release wait for the same fsyncs on
 * the libuv thread pool. Everything between two yields, including each liveness check and the
 * rename it guards, runs synchronously, so no other owner can act between a check and its commit
 * within this process.
 */
type LockSteps<A> = Generator<number, A, void>;

const resumeAfterFlush = <A>(steps: LockSteps<A>, flush: () => void): IteratorResult<number, A> => {
  try {
    flush();
  } catch (error) {
    return steps.throw(error);
  }
  return steps.next();
};

const runSynchronously = <A>(steps: LockSteps<A>): A => {
  let step = steps.next();
  while (!step.done) {
    const fd = step.value;
    step = resumeAfterFlush(steps, () => fs.fsyncSync(fd));
  }
  return step.value;
};

const fsyncOffThread = (fd: number) =>
  Effect.callback<void, NodeJS.ErrnoException>((resume) => {
    fs.fsync(fd, (error) => resume(error === null ? Effect.void : Effect.fail(error)));
  });

const isCrossProcessLockError = Schema.is(CrossProcessLockError);

const failure = (cause: unknown) =>
  isCrossProcessLockError(cause) ? cause : CrossProcessLockError.make({ reason: "unavailable" });

// Uninterruptible because abandoning the steps would leave descriptors open and a slot half-moved.
const runOffThread = Effect.fnUntraced(function* <A>(start: () => LockSteps<A>) {
  const steps = start();
  let step = yield* Effect.try({ try: () => steps.next(), catch: failure });
  while (!step.done) {
    const flushed = yield* Effect.result(fsyncOffThread(step.value));
    step = yield* Effect.try({
      try: () => (Result.isSuccess(flushed) ? steps.next() : steps.throw(flushed.failure)),
      catch: failure,
    });
  }
  return step.value;
}, Effect.uninterruptible);

// Synchronous, unlike the private-file module, because lease callbacks such as `release` are.
const privateDirectory = (directory: string, slot?: string) => {
  if (!isPrivateDirectoryInfo(fs.lstatSync(directory))) throw recovery(slot);
};
function* syncDirectory(directory: string): LockSteps<void> {
  const fd = fs.openSync(directory, flags.O_RDONLY | flags.O_NOFOLLOW);
  try {
    yield fd;
  } finally {
    fs.closeSync(fd);
  }
}
const readOwner = (directory: string): Owner => {
  privateDirectory(directory);
  const fd = fs.openSync(path.join(directory, "owner.json"), flags.O_RDONLY | flags.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      !isOwnedByCurrentUser(stat) ||
      !hasPrivateMode(stat) ||
      stat.size > 1024 ||
      stat.nlink !== 1
    )
      throw recovery();
    return decode(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
};
function* writeOwner(directory: string, owner: Owner): LockSteps<void> {
  const temporary = path.join(directory, `pending-${randomToken()}`);
  const fd = fs.openSync(
    temporary,
    flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, encode(owner), "utf8");
    yield fd;
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, path.join(directory, "owner.json"));
  yield* syncDirectory(directory);
}

/** The recorded evidence about a slot's owner that liveness checks read. */
export interface CrossProcessLockOwner extends ProcessIdentity {
  readonly token: string;
}
/** Whether an owner is positively dead; anything else keeps its slot held. */
type OwnerIsDead = (owner: CrossProcessLockOwner) => boolean;
export const ownerIsDead: OwnerIsDead = (owner) => processLiveness(owner) === "dead";

function* retire(directory: string, owner: Owner, root: string): LockSteps<void> {
  const current = readOwner(directory);
  if (current.token !== owner.token || current.phase !== "quiescent") throw recovery();
  fs.renameSync(directory, `${directory}.retired-${owner.token}`);
  yield* syncDirectory(root);
}

const cleanReleased = (directory: string, owner: Owner) => {
  try {
    const current = readOwner(directory);
    if (current.token !== owner.token || current.pid !== owner.pid || current.phase !== "quiescent")
      return;
    const names = fs.readdirSync(directory);
    if (names.length !== 1 || names[0] !== "owner.json") return;
    fs.unlinkSync(path.join(directory, "owner.json"));
    fs.rmdirSync(directory);
  } catch {}
};

const ensurePrivateRoot = (root: string): void => {
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  privateDirectory(root, root);
};

const OWNER_READ_ATTEMPTS = 3;

const readPreviousOwner = (directory: string, attempt = 1): Owner | undefined => {
  try {
    return readOwner(directory);
  } catch (error) {
    if (!isMissing(error)) throw recovery(directory);
  }
  try {
    fs.lstatSync(directory);
  } catch (statError) {
    if (isMissing(statError)) return undefined;
    throw statError;
  }
  // A releasing owner can move its slot away and a successor publish a new one between the two
  // reads above; a slot that keeps lacking its owner record is damaged.
  if (attempt < OWNER_READ_ATTEMPTS) return readPreviousOwner(directory, attempt + 1);
  throw recovery(directory);
};

function* retireDeadOwner(directory: string, previous: Owner, root: string): LockSteps<void> {
  if (previous.phase === "native-pending") throw recovery(directory);
  try {
    yield* retire(directory, previous, root);
  } catch (retireError) {
    if (!isRetireRace(retireError)) throw retireError;
  }
}

function* publishOwner(root: string, directory: string, owner: Owner): LockSteps<boolean> {
  const candidate = path.join(root, `.candidate-${owner.token}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  yield* writeOwner(candidate, owner);
  try {
    fs.renameSync(candidate, directory);
  } catch (error) {
    fs.unlinkSync(path.join(candidate, "owner.json"));
    fs.rmdirSync(candidate);
    if (isSlotOccupied(error)) return false;
    throw error;
  }
  try {
    yield* syncDirectory(root);
  } catch (error) {
    try {
      yield* retire(directory, owner, root);
    } catch {
      throw recovery();
    }
    throw error;
  }
  return true;
}

interface LeaseSteps {
  readonly mutationStarted: () => LockSteps<void>;
  readonly mutationSettled: () => LockSteps<void>;
  readonly release: () => LockSteps<void>;
}

const ownedLease = (root: string, directory: string, owner: Owner): LeaseSteps => {
  let pending = false;
  let releaseRequested = false;
  let released = false;
  let uncertain = false;
  function* uncertainOnFailure(commit: LockSteps<void>): LockSteps<void> {
    try {
      yield* commit;
    } catch (error) {
      uncertain = true;
      throw error;
    }
  }
  const check = () => {
    if (released || uncertain || readOwner(directory).token !== owner.token) throw recovery();
  };
  function* release(): LockSteps<void> {
    releaseRequested = true;
    if (released || pending || uncertain) return;
    check();
    const destination = `${directory}.released-${owner.token}`;
    try {
      fs.renameSync(directory, destination);
    } catch (error) {
      uncertain = true;
      throw error;
    }
    released = true;
    yield* syncDirectory(root);
    cleanReleased(destination, owner);
  }
  return {
    *mutationStarted() {
      check();
      if (pending || releaseRequested) throw recovery();
      pending = true;
      yield* uncertainOnFailure(writeOwner(directory, { ...owner, phase: "native-pending" }));
    },
    *mutationSettled() {
      check();
      if (!pending) throw recovery();
      yield* uncertainOnFailure(writeOwner(directory, owner));
      pending = false;
      if (releaseRequested) yield* release();
    },
    release,
  };
};

function* acquireSteps(
  namespace: string,
  options: CrossProcessLockOptions,
  retryAfterRetire: boolean,
  isDead: OwnerIsDead,
): LockSteps<LeaseSteps | undefined> {
  const root = options.directory;
  ensurePrivateRoot(root);
  const directory = path.join(root, sha256Text(namespace));
  const previous = readPreviousOwner(directory);
  if (previous) {
    if (!isDead(previous)) return undefined;
    yield* retireDeadOwner(directory, previous, root);
    return retryAfterRetire ? yield* acquireSteps(namespace, options, false, isDead) : undefined;
  }
  const { started } = currentProcessIdentity();
  const owner: Owner = {
    version: 1,
    token: randomToken(),
    pid: process.pid,
    ...(started !== undefined && { started }),
    phase: "quiescent",
  };
  return (yield* publishOwner(root, directory, owner))
    ? ownedLease(root, directory, owner)
    : undefined;
}

const synchronousLease = (lease: LeaseSteps | undefined): CrossProcessLease | undefined =>
  lease === undefined
    ? undefined
    : {
        mutationStarted: () => runSynchronously(lease.mutationStarted()),
        mutationSettled: () => runSynchronously(lease.mutationSettled()),
        release: () => runSynchronously(lease.release()),
      };

/** Acquires with every fsync inline, for callers that can't wait for the thread pool. */
export const acquireNativeLock = (
  namespace: string,
  options: CrossProcessLockOptions,
  retryAfterRetire = false,
): CrossProcessLease | undefined =>
  synchronousLease(
    runSynchronously(acquireSteps(namespace, options, retryAfterRetire, ownerIsDead)),
  );

/** A held lock whose release waits for its fsyncs on the libuv thread pool. */
export interface OffThreadLease {
  readonly release: Effect.Effect<void, CrossProcessLockError>;
}

/**
 * `tryAcquire` with the caller's liveness check, whose lease also releases off the event loop. Its
 * lease has no native-mutation phases.
 */
export const acquireLockOffThread = (
  namespace: string,
  options: CrossProcessLockOptions,
  isDead: OwnerIsDead,
): Effect.Effect<OffThreadLease | undefined, CrossProcessLockError> =>
  runOffThread(() => acquireSteps(namespace, options, true, isDead)).pipe(
    Effect.map((lease) =>
      lease === undefined ? undefined : { release: runOffThread(() => lease.release()) },
    ),
  );

export interface CrossProcessLockHolder {
  readonly slot: string;
  /** The current owner's process id, when its evidence is readable. */
  readonly ownerPid?: number;
}

/** Names a namespace's slot and its current owner for diagnostics; it never changes the lock. */
export const crossProcessLockHolder = (
  namespace: string,
  options: CrossProcessLockOptions,
): CrossProcessLockHolder => {
  const slot = path.join(options.directory, sha256Text(namespace));
  try {
    return { slot, ownerPid: readOwner(slot).pid };
  } catch {
    return { slot };
  }
};

export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockContract>()(
  "pi-cosmic-core/platform/cross-process-lock/CrossProcessLock",
) {
  static readonly layer = (options: CrossProcessLockOptions) =>
    Layer.succeed(this, {
      tryAcquire: (namespace) =>
        runOffThread(() => acquireSteps(namespace, options, true, ownerIsDead)).pipe(
          Effect.map(synchronousLease),
        ),
    });
}
