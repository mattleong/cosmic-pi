import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { sha256Text } from "pi-cosmic-core/security/sha256";
import {
  CrossProcessLock,
  type CrossProcessLease,
  type CrossProcessLockContract,
} from "pi-cosmic-core/platform/cross-process-lock";
import { ensurePrivateDirectory } from "pi-cosmic-core/platform/private-file";
import { nodeFsPromises as fs, nodePath } from "pi-cosmic-core/platform/node-builtins";
import { SUBAGENT_STATE_ROOT, WRITER_LEASE_ROOT } from "./private-state.ts";

const MAX_FILESYSTEM_IDENTITY_CHARS = 256;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FILESYSTEM_IDENTITY_PATTERN = /^dev:[a-f0-9]+;ino:[a-f0-9]+$/;

class WriterCwdCanonicalizationError extends Schema.TaggedError<
  WriterCwdCanonicalizationError,
  { readonly brand: unique symbol }
>()("WriterCwdCanonicalizationError", { message: Schema.String }) {}

export class WriterLeaseConflictError extends Schema.TaggedError<
  WriterLeaseConflictError,
  { readonly brand: unique symbol }
>()("WriterLeaseConflictError", {
  message: Schema.String,
  reason: Schema.Literals(["live", "recovery-required"]),
}) {}

export class WriterLeaseAcquireError extends Schema.TaggedError<
  WriterLeaseAcquireError,
  { readonly brand: unique symbol }
>()("WriterLeaseAcquireError", { message: Schema.String }) {}

export class WriterLeaseMarkError extends Schema.TaggedError<
  WriterLeaseMarkError,
  { readonly brand: unique symbol }
>()("WriterLeaseMarkError", { message: Schema.String }) {}

export class WriterLeaseReleaseError extends Schema.TaggedError<
  WriterLeaseReleaseError,
  { readonly brand: unique symbol }
>()("WriterLeaseReleaseError", { message: Schema.String }) {}

export interface CanonicalWriterCwd {
  readonly path: string;
  readonly filesystemIdentity: string;
  readonly digest: string;
}

export interface WriterLease {
  readonly canonicalCwd: string;
  readonly filesystemIdentityDigest: string;
  readonly runId: string;
}

interface WriterLeaseAcquireRequest {
  readonly cwd: CanonicalWriterCwd;
  readonly runId: string;
}

export interface WriterLeaseContract {
  readonly canonicalize: (
    cwd: string,
  ) => Effect.Effect<CanonicalWriterCwd, WriterCwdCanonicalizationError>;
  readonly acquire: (
    request: WriterLeaseAcquireRequest,
  ) => Effect.Effect<WriterLease, WriterLeaseConflictError | WriterLeaseAcquireError>;
  readonly markSpawnStarted: (
    lease: WriterLease,
  ) => Effect.Effect<WriterLease, WriterLeaseMarkError>;
  readonly release: (lease: WriterLease) => Effect.Effect<void, WriterLeaseReleaseError>;
}

type OwnershipPhase = "reserved" | "spawn-started" | "uncertain" | "released";

interface Ownership {
  readonly handle: CrossProcessLease;
  phase: OwnershipPhase;
}

const validFilesystemIdentity = (cwd: CanonicalWriterCwd): boolean =>
  cwd.filesystemIdentity.length <= MAX_FILESYSTEM_IDENTITY_CHARS &&
  FILESYSTEM_IDENTITY_PATTERN.test(cwd.filesystemIdentity) &&
  DIGEST_PATTERN.test(cwd.digest) &&
  sha256Text(cwd.filesystemIdentity) === cwd.digest;

export const canonicalizeWriterDirectory: WriterLeaseContract["canonicalize"] = (cwd) =>
  Effect.tryPromise({
    try: () =>
      fs.realpath(cwd).then((path) =>
        fs.stat(path, { bigint: true }).then((stat) => {
          const filesystemIdentity = `dev:${stat.dev.toString(16)};ino:${stat.ino.toString(16)}`;
          const canonical = { path, filesystemIdentity, digest: sha256Text(filesystemIdentity) };
          if (!stat.isDirectory() || !validFilesystemIdentity(canonical))
            throw new Error("identity");
          return canonical;
        }),
      ),
    catch: () =>
      WriterCwdCanonicalizationError.make({
        message:
          "Writer cwd could not be resolved to a stable existing local-directory identity; no writer backend was started.",
      }),
  });

const recoveryMessage = (slot: string | undefined): string =>
  `Writer ownership of this directory needs manual recovery, so writer startup was denied.\n${
    slot === undefined
      ? "Its writer lock is damaged or was left by a Pi session that ended while a writer ran."
      : `Its lock at ${slot} is damaged or was left by a Pi session that ended while a writer ran. Remove that lock directory only after confirming that no writer from an earlier session is still running: its owner.json names the owner's process id.`
  }`;

const makeWriterLease = (
  agentDirectory: string,
  lock: CrossProcessLockContract,
): WriterLeaseContract => {
  const packageRoot = nodePath.join(agentDirectory, SUBAGENT_STATE_ROOT);
  const owners = new WeakMap<WriterLease, Ownership>();

  const denied = (reason: string) =>
    WriterLeaseAcquireError.make({ message: `${reason}; writer startup was denied.` });

  const prepare = ensurePrivateDirectory(packageRoot).pipe(
    Effect.mapError(() => denied("Unable to prepare private writer-lease state")),
  );

  const transition = <E>(
    lease: WriterLease,
    from: ReadonlyArray<OwnershipPhase>,
    to: OwnershipPhase,
    error: () => E,
    commit: (handle: CrossProcessLease, phase: OwnershipPhase) => void,
  ): Effect.Effect<WriterLease, E> =>
    Effect.suspend(() => {
      const owned = owners.get(lease);
      if (!owned || !from.includes(owned.phase)) return Effect.fail(error());
      const phase = owned.phase;
      owned.phase = "uncertain";
      try {
        commit(owned.handle, phase);
      } catch {
        return Effect.fail(error());
      }
      owned.phase = to;
      return Effect.succeed(lease);
    });

  const acquire: WriterLeaseContract["acquire"] = Effect.fn("WriterLease.acquire")(function* ({
    cwd,
    runId,
  }) {
    if (!validFilesystemIdentity(cwd))
      return yield* denied("Writer-lease ownership input was invalid");
    yield* Effect.interruptible(prepare);
    return yield* lock.tryAcquire(cwd.digest).pipe(
      Effect.mapError((error) =>
        error.reason === "recovery-required"
          ? WriterLeaseConflictError.make({
              reason: "recovery-required",
              message: recoveryMessage(error.slot),
            })
          : denied("Unable to acquire private writer-lease state"),
      ),
      Effect.flatMap((handle) => {
        if (!handle)
          return Effect.fail(
            WriterLeaseConflictError.make({
              reason: "live",
              message: "Another live writer already owns this filesystem directory identity.",
            }),
          );
        const lease: WriterLease = {
          canonicalCwd: cwd.path,
          filesystemIdentityDigest: cwd.digest,
          runId,
        };
        owners.set(lease, { handle, phase: "reserved" });
        return Effect.succeed(lease);
      }),
      Effect.uninterruptible,
    );
  });

  return {
    canonicalize: canonicalizeWriterDirectory,
    acquire,
    markSpawnStarted: (lease) =>
      transition(
        lease,
        ["reserved"],
        "spawn-started",
        () =>
          WriterLeaseMarkError.make({
            message:
              "Writer-lease spawn-started evidence could not be committed durably; no backend spawn is permitted and ownership remains fail-closed.",
          }),
        (handle) => handle.mutationStarted(),
      ),
    release: (lease) =>
      transition(
        lease,
        ["reserved", "spawn-started"],
        "released",
        () =>
          WriterLeaseReleaseError.make({
            message:
              "Writer-lease release could not be confirmed; the lease remains held and fail-closed.",
          }),
        (handle, phase) => {
          if (phase === "spawn-started") handle.mutationSettled();
          handle.release();
        },
      ).pipe(Effect.asVoid),
  };
};

export class WriterLeaseService extends Context.Service<WriterLeaseService, WriterLeaseContract>()(
  "pi-subagents/boundary/writer-lease/WriterLeaseService",
) {
  /** Leases through whichever cross-process lock the context provides. */
  static readonly layerWithLock = (options: {
    readonly agentDirectory: string;
  }): Layer.Layer<WriterLeaseService, never, CrossProcessLock> =>
    Layer.effect(
      this,
      CrossProcessLock.useSync((lock) => makeWriterLease(options.agentDirectory, lock)),
    );

  static readonly layer = (options: {
    readonly agentDirectory: string;
  }): Layer.Layer<WriterLeaseService> =>
    WriterLeaseService.layerWithLock(options).pipe(
      Layer.provide(
        CrossProcessLock.layer({
          directory: nodePath.join(options.agentDirectory, SUBAGENT_STATE_ROOT, WRITER_LEASE_ROOT),
        }),
      ),
    );
}
