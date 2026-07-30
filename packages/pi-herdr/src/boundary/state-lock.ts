// Node's atomic directory creation is the portability boundary for coordination
// between independent Pi OS processes.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HerdrStateError } from "../herd/errors.ts";

const LOCK_SUFFIX = ".lock";
const OWNER_BASENAME = "owner";
const ACQUIRE_TIMEOUT_MILLIS = 120_000;
const RETRY_MILLIS = 50;
const INCOMPLETE_OWNER_GRACE_MILLIS = 5_000;

interface LockOwner {
  readonly token: string;
  readonly pid: number;
}

interface AcquiredLock extends LockOwner {
  readonly lockPath: string;
}

type RestoreInterruptibility = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const decodeOwner = (input: string): LockOwner | undefined => {
  const [token, rawPid] = input.split("\n", 2);
  const pid = Number(rawPid);
  return token && Number.isSafeInteger(pid) && pid > 0 ? { token, pid } : undefined;
};

const ownerIsAlive = (owner: LockOwner): boolean => {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    return code !== "ESRCH" && code !== "EINVAL";
  }
};

const removeIfOwned = async (lock: AcquiredLock): Promise<void> => {
  const ownerPath = join(lock.lockPath, OWNER_BASENAME);
  let owner: LockOwner | undefined;
  try {
    owner = decodeOwner(await readFile(ownerPath, "utf8"));
  } catch {
    return;
  }
  if (owner?.token !== lock.token || owner.pid !== lock.pid) return;
  const releasedPath = `${lock.lockPath}.released-${lock.token}`;
  try {
    await rename(lock.lockPath, releasedPath);
    await rm(releasedPath, { recursive: true, force: true });
  } catch {
    // A lost ownership race must never remove another process's lock.
  }
};

const reclaimIfOrphaned = async (lockPath: string, token: string, now: number): Promise<void> => {
  const ownerPath = join(lockPath, OWNER_BASENAME);
  let ownerText: string | undefined;
  let owner: LockOwner | undefined;
  try {
    ownerText = await readFile(ownerPath, "utf8");
    owner = decodeOwner(ownerText);
  } catch {
    try {
      const metadata = await stat(lockPath);
      if (now - metadata.mtimeMs < INCOMPLETE_OWNER_GRACE_MILLIS) return;
    } catch {
      return;
    }
  }
  if (owner && ownerIsAlive(owner)) return;
  const orphanPath = `${lockPath}.orphan-${token}`;
  try {
    await rename(lockPath, orphanPath);
  } catch {
    return;
  }
  let movedOwnerText: string | undefined;
  try {
    movedOwnerText = await readFile(join(orphanPath, OWNER_BASENAME), "utf8");
  } catch {
    // A malformed orphan remains undefined for exact comparison below.
  }
  if (movedOwnerText !== ownerText) {
    try {
      await rename(orphanPath, lockPath);
    } catch {
      // Never delete a directory whose owner changed during reclamation.
    }
    return;
  }
  await rm(orphanPath, { recursive: true, force: true });
};

const stateError = (lockPath: string) =>
  new HerdrStateError({
    operation: "coordinate",
    path: lockPath,
    message: "Unable to coordinate pi-herdr state across Pi processes.",
  });

const tryAcquire = (
  lockPath: string,
  token: string,
): Effect.Effect<AcquiredLock | undefined, HerdrStateError> =>
  Effect.tryPromise({
    try: async () => {
      const candidatePath = `${lockPath}.candidate-${token}`;
      const lock = { lockPath, token, pid: process.pid } satisfies AcquiredLock;
      try {
        await mkdir(candidatePath, { mode: 0o700 });
        await writeFile(join(candidatePath, OWNER_BASENAME), `${lock.token}\n${lock.pid}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        try {
          await rename(candidatePath, lockPath);
        } catch (error) {
          if (
            errorCode(error) === "EEXIST" ||
            errorCode(error) === "ENOTEMPTY" ||
            errorCode(error) === "EPERM"
          ) {
            await rm(candidatePath, { recursive: true, force: true });
            return undefined;
          }
          throw error;
        }
      } catch (error) {
        await rm(candidatePath, { recursive: true, force: true });
        throw error;
      }
      return lock;
    },
    catch: () => stateError(lockPath),
  });

const acquire = (
  key: string,
  restore: RestoreInterruptibility,
): Effect.Effect<AcquiredLock, HerdrStateError> => {
  const lockPath = `${key}${LOCK_SUFFIX}`;
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(lockPath), { recursive: true }),
      catch: () => stateError(lockPath),
    });
    const token = randomUUID();
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + ACQUIRE_TIMEOUT_MILLIS;
    const loop: Effect.Effect<AcquiredLock, HerdrStateError> = Effect.suspend(() =>
      Effect.gen(function* () {
        const lock = yield* tryAcquire(lockPath, token);
        if (lock) return lock;
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.promise(() => reclaimIfOrphaned(lockPath, token, now));
        if (now >= deadline) return yield* stateError(lockPath);
        yield* restore(Effect.sleep(`${RETRY_MILLIS} millis`));
        return yield* loop;
      }),
    );
    return yield* loop;
  });
};

const release = (lock: AcquiredLock): Effect.Effect<void> =>
  Effect.promise(() => removeIfOwned(lock));

export const withHerdrStateLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HerdrStateError, R> =>
  Effect.uninterruptibleMask((restore) =>
    acquire(key, restore).pipe(
      Effect.flatMap((lock) => restore(effect).pipe(Effect.ensuring(release(lock)))),
    ),
  );
