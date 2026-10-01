// Writer ownership adapts pi-cosmic-core's CrossProcessLock; Node supplies stable cwd identity.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  sha256Text,
  CrossProcessLock,
  type CrossProcessLease,
  type CrossProcessLockContract,
} from "pi-cosmic-core";
import { ensurePrivateDirectory, nodeErrorCode } from "./harness-shared.ts";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

const { join } = nodePath;

const MAX_FILESYSTEM_IDENTITY_CHARS = 256;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FILESYSTEM_IDENTITY_PATTERN = /^dev:[a-f0-9]+;ino:[a-f0-9]+$/;

export class WriterCwdCanonicalizationError extends Schema.TaggedError<WriterCwdCanonicalizationError>()(
  "WriterCwdCanonicalizationError",
  { message: Schema.String },
) {}

export class WriterLeaseConflictError extends Schema.TaggedError<WriterLeaseConflictError>()(
  "WriterLeaseConflictError",
  { message: Schema.String, reason: Schema.Literals(["live", "recovery-required"]) },
) {}

export class WriterLeaseAcquireError extends Schema.TaggedError<WriterLeaseAcquireError>()(
  "WriterLeaseAcquireError",
  { message: Schema.String },
) {}

export class WriterLeaseMarkError extends Schema.TaggedError<WriterLeaseMarkError>()(
  "WriterLeaseMarkError",
  { message: Schema.String },
) {}

export class WriterLeaseReleaseError extends Schema.TaggedError<WriterLeaseReleaseError>()(
  "WriterLeaseReleaseError",
  { message: Schema.String },
) {}

export interface CanonicalWriterCwd {
  /** Canonical path is retained only for launch and diagnostics. */
  readonly path: string;
  /** Bounded local filesystem object identity, never persisted verbatim. */
  readonly filesystemIdentity: string;
  /** SHA-256 of filesystemIdentity; this is the coordination and in-memory guard key. */
  readonly digest: string;
}

/** Opaque ownership: only the service instance that acquired this exact object can use it. */
export interface WriterLease {
  readonly canonicalCwd: string;
  readonly filesystemIdentityDigest: string;
  readonly runId: string;
}

export interface WriterLeaseAcquireRequest {
  readonly cwd: CanonicalWriterCwd;
  readonly runId: string;
}

export interface WriterLeaseContract {
  /** Injected in tests; production is process.platform. */
  readonly platform: NodeJS.Platform;
  readonly canonicalize: (
    cwd: string,
  ) => Effect.Effect<CanonicalWriterCwd, WriterCwdCanonicalizationError>;
  readonly acquire: (
    request: WriterLeaseAcquireRequest,
  ) => Effect.Effect<WriterLease, WriterLeaseConflictError | WriterLeaseAcquireError>;
  /** Durable native-pending commit that must confirm before any spawn; returns the same lease. */
  readonly markSpawnStarted: (
    lease: WriterLease,
  ) => Effect.Effect<WriterLease, WriterLeaseMarkError>;
  /** Settles a marked lease before releasing it. Any failure keeps the slot held for good. */
  readonly release: (lease: WriterLease) => Effect.Effect<void, WriterLeaseReleaseError>;
}

type OwnershipPhase = "reserved" | "spawn-started" | "uncertain" | "released";

interface Ownership {
  readonly handle: CrossProcessLease;
  phase: OwnershipPhase;
}

const digest = (value: string): string => sha256Text(value);

const validFilesystemIdentity = (cwd: CanonicalWriterCwd): boolean =>
  cwd.filesystemIdentity.length <= MAX_FILESYSTEM_IDENTITY_CHARS &&
  FILESYSTEM_IDENTITY_PATTERN.test(cwd.filesystemIdentity) &&
  DIGEST_PATTERN.test(cwd.digest) &&
  digest(cwd.filesystemIdentity) === cwd.digest;

const canonicalize: WriterLeaseContract["canonicalize"] = (cwd) =>
  Effect.tryPromise({
    try: () =>
      fs.realpath(cwd).then((path) =>
        fs.stat(path, { bigint: true }).then((stat) => {
          if (!stat.isDirectory()) throw new Error("not-directory");
          const filesystemIdentity = `dev:${stat.dev.toString(16)};ino:${stat.ino.toString(16)}`;
          if (
            filesystemIdentity.length > MAX_FILESYSTEM_IDENTITY_CHARS ||
            !FILESYSTEM_IDENTITY_PATTERN.test(filesystemIdentity)
          )
            throw new Error("identity");
          return { path, filesystemIdentity, digest: digest(filesystemIdentity) };
        }),
      ),
    catch: () =>
      new WriterCwdCanonicalizationError({
        message:
          "Writer cwd could not be resolved to a stable existing local-directory identity; no writer backend was started.",
      }),
  });

export const makeWriterLease = (
  agentDirectory: string,
  lock: CrossProcessLockContract,
): WriterLeaseContract => {
  const packageRoot = join(agentDirectory, "subagents");
  const owners = new WeakMap<WriterLease, Ownership>();

  const denied = (reason: string) =>
    new WriterLeaseAcquireError({ message: `${reason}; writer startup was denied.` });

  // Pre-ownership I/O. The v2 check is a temporary migration shim; docs/local-backends.md
  // records its removal criterion.
  const prepare = (cwdDigest: string) =>
    Effect.gen(function* () {
      const legacy = join(packageRoot, "writer-leases-v2", `${cwdDigest}.lease`);
      const absent = yield* Effect.promise(() =>
        fs.lstat(legacy).then(
          () => false,
          (error) => nodeErrorCode(error) === "ENOENT",
        ),
      );
      if (!absent)
        return yield* new WriterLeaseConflictError({
          reason: "recovery-required",
          message: `A protocol-v2 writer lease remains at ${legacy}. It may belong to an older Pi session that is still running, so writer startup was denied. Remove it only after every older Pi session has exited.`,
        });
      yield* Effect.tryPromise({
        try: () => ensurePrivateDirectory(packageRoot),
        catch: () => denied("Unable to prepare private writer-lease state"),
      });
    });

  /**
   * Ownership is uncertain until a core commit returns, so any throw fails closed for good. The
   * phase change and the commit run in one synchronous step, with no interruption point between.
   */
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

  const acquire: WriterLeaseContract["acquire"] = ({ cwd, runId }) =>
    Effect.gen(function* () {
      if (process.platform === "win32" || !validFilesystemIdentity(cwd))
        return yield* denied("Writer-lease ownership input or platform was invalid");
      // Pre-ownership I/O stays interruptible even under a caller's acquisition mask.
      yield* Effect.interruptible(prepare(cwd.digest));
      return yield* lock.tryAcquire(cwd.digest).pipe(
        Effect.mapError((error) =>
          error.reason === "recovery-required"
            ? new WriterLeaseConflictError({
                reason: "recovery-required",
                message:
                  "Writer-lease ownership state needs manual recovery; ownership remains locked and writer startup was denied.",
              })
            : denied("Unable to acquire private writer-lease state"),
        ),
        Effect.flatMap((handle) => {
          if (!handle)
            return Effect.fail(
              new WriterLeaseConflictError({
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
        // A live core handle is always registered, so interruption cannot leak it.
        Effect.uninterruptible,
      );
    });

  return {
    platform: process.platform,
    canonicalize,
    acquire,
    markSpawnStarted: (lease) =>
      transition(
        lease,
        ["reserved"],
        "spawn-started",
        () =>
          new WriterLeaseMarkError({
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
          new WriterLeaseReleaseError({
            message:
              "Writer-lease release could not be confirmed; the lease remains held and fail-closed.",
          }),
        (handle, phase) => {
          // Core defers release while native work is pending, so settle durably first.
          if (phase === "spawn-started") handle.mutationSettled();
          handle.release();
        },
      ).pipe(Effect.asVoid),
  };
};

export class WriterLeaseService extends Context.Service<WriterLeaseService, WriterLeaseContract>()(
  "pi-subagents/boundary/writer-lease/WriterLeaseService",
) {
  /** One private per-agent-directory lock root; exclusion covers sessions sharing it. */
  static readonly layer = (options: {
    readonly agentDirectory: string;
  }): Layer.Layer<WriterLeaseService> =>
    Layer.effect(
      this,
      CrossProcessLock.useSync((lock) => makeWriterLease(options.agentDirectory, lock)),
    ).pipe(
      Layer.provide(
        CrossProcessLock.layer({
          directory: join(options.agentDirectory, "subagents", "writer-leases-v3"),
        }),
      ),
    );
}
