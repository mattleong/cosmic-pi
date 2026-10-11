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
    slot: Schema.optionalKey(Schema.String),
  },
) {}

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
    try {
      fs.lstatSync(directory);
      throw recovery(directory);
    } catch (statError) {
      if (!code("ENOENT")(statError)) throw statError;
    }
  }
  if (previous) {
    if (!dead(previous.pid)) return undefined;
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

const failure = (cause: unknown) =>
  cause instanceof CrossProcessLockError
    ? cause
    : new CrossProcessLockError({ reason: "unavailable" });

export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockContract>()(
  "pi-cosmic-core/platform/cross-process-lock/CrossProcessLock",
) {
  static readonly layer = (options: CrossProcessLockOptions) =>
    Layer.succeed(this, {
      tryAcquire: (namespace) =>
        Effect.try({ try: () => acquireNativeLock(namespace, options, true), catch: failure }),
    });
}
