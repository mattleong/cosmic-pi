import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { sha256Text } from "../security/sha256.ts";
import { synchronousRandomHex } from "./native-crypto.ts";
import { nodeFsConstants as flags, nodeLockFs as fs, nodePath as path } from "./node-builtins.ts";
import { hasPrivateMode, isOwnedByCurrentUser, isPrivateDirectoryInfo } from "./private-file.ts";
import { currentProcessIdentity, processLiveness } from "./process-start.ts";

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
  new CrossProcessLockError({ reason: "recovery-required", ...(slot !== undefined && { slot }) });
const code = (...expected: string[]) =>
  Schema.is(Schema.Struct({ code: Schema.Literals(expected) }));
const isExists = code("EEXIST");
const isMissing = code("ENOENT");
const isRetireRace = code("ENOENT", "ENOTEMPTY", "EEXIST");
const isSlotOccupied = code("EEXIST", "ENOTEMPTY");
// Synchronous, unlike the private-file module, because lease callbacks such as `release` are.
const privateDirectory = (directory: string, slot?: string) => {
  if (!isPrivateDirectoryInfo(fs.lstatSync(directory))) throw recovery(slot);
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
const dead = (owner: Owner): boolean => processLiveness(owner) === "dead";
const retire = (directory: string, owner: Owner, root: string) => {
  const current = readOwner(directory);
  if (current.token !== owner.token || current.phase !== "quiescent") throw recovery();
  fs.renameSync(directory, `${directory}.retired-${owner.token}`);
  syncDirectory(root);
};

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

const retireDeadOwner = (directory: string, previous: Owner, root: string): void => {
  if (previous.phase === "native-pending") throw recovery(directory);
  try {
    retire(directory, previous, root);
  } catch (retireError) {
    if (!isRetireRace(retireError)) throw retireError;
  }
};

const publishOwner = (root: string, directory: string, owner: Owner): boolean => {
  const candidate = path.join(root, `.candidate-${owner.token}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  writeOwner(candidate, owner);
  try {
    fs.renameSync(candidate, directory);
  } catch (error) {
    fs.unlinkSync(path.join(candidate, "owner.json"));
    fs.rmdirSync(candidate);
    if (isSlotOccupied(error)) return false;
    throw error;
  }
  try {
    syncDirectory(root);
  } catch (error) {
    try {
      retire(directory, owner, root);
    } catch {
      throw recovery();
    }
    throw error;
  }
  return true;
};

const ownedLease = (root: string, directory: string, owner: Owner): CrossProcessLease => {
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
    uncertainOnFailure(() => fs.renameSync(directory, destination));
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

export const acquireNativeLock = (
  namespace: string,
  options: CrossProcessLockOptions,
  retryAfterRetire = false,
): CrossProcessLease | undefined => {
  const root = options.directory;
  ensurePrivateRoot(root);
  const directory = path.join(root, sha256Text(namespace));
  const previous = readPreviousOwner(directory);
  if (previous) {
    if (!dead(previous)) return undefined;
    retireDeadOwner(directory, previous, root);
    return retryAfterRetire ? acquireNativeLock(namespace, options) : undefined;
  }
  const { started } = currentProcessIdentity();
  const owner: Owner = {
    version: 1,
    token: randomToken(),
    pid: process.pid,
    ...(started !== undefined && { started }),
    phase: "quiescent",
  };
  return publishOwner(root, directory, owner) ? ownedLease(root, directory, owner) : undefined;
};

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

const isCrossProcessLockError = Schema.is(CrossProcessLockError);

const failure = (cause: unknown) =>
  isCrossProcessLockError(cause) ? cause : new CrossProcessLockError({ reason: "unavailable" });

export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockContract>()(
  "pi-cosmic-core/platform/cross-process-lock/CrossProcessLock",
) {
  static readonly layer = (options: CrossProcessLockOptions) =>
    Layer.succeed(this, {
      tryAcquire: (namespace) =>
        Effect.try({ try: () => acquireNativeLock(namespace, options, true), catch: failure }),
    });
}
