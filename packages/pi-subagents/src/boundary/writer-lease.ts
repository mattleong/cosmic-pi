// Cross-process writer ownership requires Node's exclusive directory and stable-file primitives.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nodeErrorCode } from "./harness-shared.ts";

const LEASE_VERSION = 2 as const;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const MAX_ID_CHARS = 256;
const MAX_FILESYSTEM_IDENTITY_CHARS = 256;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FILESYSTEM_IDENTITY_PATTERN = /^dev:[a-f0-9]+;ino:[a-f0-9]+$/;
const OWNER_FILE = "owner.json";

const DigestSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isMinLength(64),
  Schema.isPattern(DIGEST_PATTERN),
);
const BoundedIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ID_CHARS),
);
const PositiveIntegerSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const NonNegativeIntegerSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const WriterLeaseEvidenceFields = {
  version: Schema.Literal(LEASE_VERSION),
  ownershipToken: DigestSchema,
  filesystemIdentityDigest: DigestSchema,
  parentPid: PositiveIntegerSchema,
  parentProcessStartedAtMillis: NonNegativeIntegerSchema,
  ownerNonce: DigestSchema,
  sessionId: BoundedIdSchema,
  runId: BoundedIdSchema,
  acquiredAtMillis: NonNegativeIntegerSchema,
};

export const WriterLeaseEvidenceSchema = Schema.Union([
  Schema.Struct({
    ...WriterLeaseEvidenceFields,
    phase: Schema.Literal("reserved"),
  }),
  Schema.Struct({
    ...WriterLeaseEvidenceFields,
    phase: Schema.Literal("spawn-started"),
    spawnStartedAtMillis: NonNegativeIntegerSchema,
  }),
]);

export type WriterLeaseEvidence = Schema.Schema.Type<typeof WriterLeaseEvidenceSchema>;

export class WriterCwdCanonicalizationError extends Schema.TaggedError<WriterCwdCanonicalizationError>()(
  "WriterCwdCanonicalizationError",
  { message: Schema.String },
) {}

export class WriterLeaseConflictError extends Schema.TaggedError<WriterLeaseConflictError>()(
  "WriterLeaseConflictError",
  {
    message: Schema.String,
    reason: Schema.Union([
      Schema.Literal("live"),
      Schema.Literal("uncertain"),
      Schema.Literal("corrupt"),
      Schema.Literal("transitional"),
      Schema.Literal("spawn-started"),
      Schema.Literal("contended"),
    ]),
    ownerPid: Schema.optional(Schema.Number),
    ownerSessionId: Schema.optional(Schema.String),
    ownerRunId: Schema.optional(Schema.String),
  },
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

export interface WriterLease {
  readonly canonicalCwd: string;
  readonly filesystemIdentityDigest: string;
  readonly leasePath: string;
  readonly ownershipToken: string;
  readonly evidence: WriterLeaseEvidence;
}

export interface WriterLeaseAcquireRequest {
  readonly cwd: CanonicalWriterCwd;
  readonly sessionId: string;
  readonly runId: string;
}

export interface WriterLeaseShape {
  /** Injected in tests; production is process.platform. */
  readonly platform: NodeJS.Platform;
  readonly canonicalize: (
    cwd: string,
  ) => Effect.Effect<CanonicalWriterCwd, WriterCwdCanonicalizationError>;
  readonly acquire: (
    request: WriterLeaseAcquireRequest,
  ) => Effect.Effect<WriterLease, WriterLeaseConflictError | WriterLeaseAcquireError>;
  /** Durable ownership-token-checked transition which must confirm before any backend spawn call. */
  readonly markSpawnStarted: (
    lease: WriterLease,
  ) => Effect.Effect<WriterLease, WriterLeaseMarkError>;
  readonly release: (lease: WriterLease) => Effect.Effect<void, WriterLeaseReleaseError>;
}

export type WriterOwnerLiveness = "alive" | "dead" | "uncertain";

export interface WriterLeaseLayerOptions {
  readonly agentDirectory: string;
  readonly platform?: NodeJS.Platform | undefined;
  readonly parentPid?: number | undefined;
  readonly parentProcessStartedAtMillis?: number | undefined;
  readonly ownerNonce?: string | undefined;
  readonly nowMillis?: (() => number) | undefined;
  readonly randomToken?: (() => string) | undefined;
  readonly probeOwner?: ((pid: number) => WriterOwnerLiveness) | undefined;
  /** Narrow synchronization seam for deterministic release-ABA tests. */
  readonly beforeReleaseRename?: (() => Promise<void>) | undefined;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (): string => randomBytes(32).toString("hex");

export const writerLeaseRoot = (agentDirectory: string): string =>
  join(agentDirectory, "subagents", "writer-leases-v2");

export const writerLeasePath = (agentDirectory: string, filesystemIdentityDigest: string): string =>
  join(writerLeaseRoot(agentDirectory), `${filesystemIdentityDigest}.lease`);

const evidencePath = (leasePath: string): string => join(leasePath, OWNER_FILE);
const transitionPath = (leasePath: string, ownershipToken: string): string =>
  join(leasePath, `.${OWNER_FILE}.spawn-${digest(ownershipToken).slice(0, 32)}.tmp`);
const tombstonePath = (leasePath: string, ownershipToken: string): string =>
  `${leasePath}.tombstone-${digest(`lease:${ownershipToken}`).slice(0, 40)}`;

const conflict = (
  reason: WriterLeaseConflictError["reason"],
  message: string,
  evidence?: WriterLeaseEvidence,
): WriterLeaseConflictError =>
  new WriterLeaseConflictError({
    reason,
    message,
    ...(evidence
      ? {
          ownerPid: evidence.parentPid,
          ownerSessionId: evidence.sessionId,
          ownerRunId: evidence.runId,
        }
      : {}),
  });

const probeProcess = (pid: number): WriterOwnerLiveness => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ESRCH") return "dead";
    // EPERM and every unfamiliar platform result are ownership-uncertain.
    return "uncertain";
  }
};

class TransitionalEvidenceError {
  readonly _tag = "TransitionalEvidenceError";
}

interface StableEvidenceSource {
  readonly source: string;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
}

const sameEntries = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const readStableEvidenceSource = async (leasePath: string): Promise<StableEvidenceSource> => {
  const beforeDirectory = await fs.lstat(leasePath, { bigint: true });
  if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) throw new Error("type");
  const beforeEntries = (await fs.readdir(leasePath)).sort();
  if (!sameEntries(beforeEntries, [OWNER_FILE])) throw new TransitionalEvidenceError();
  const path = evidencePath(leasePath);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_EVIDENCE_BYTES)) throw new Error("size");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const afterDirectory = await fs.lstat(leasePath, { bigint: true });
    const afterEntries = (await fs.readdir(leasePath)).sort();
    if (
      bytes.byteLength > MAX_EVIDENCE_BYTES ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== Number(before.size) ||
      beforeDirectory.dev !== afterDirectory.dev ||
      beforeDirectory.ino !== afterDirectory.ino ||
      !sameEntries(beforeEntries, afterEntries)
    )
      throw new TransitionalEvidenceError();
    return {
      source: bytes.toString("utf8"),
      directoryDevice: beforeDirectory.dev,
      directoryInode: beforeDirectory.ino,
    };
  } finally {
    await handle.close();
  }
};

interface DecodedStableEvidence extends StableEvidenceSource {
  readonly evidence: WriterLeaseEvidence;
}

const readEvidence = (
  leasePath: string,
): Effect.Effect<DecodedStableEvidence, WriterLeaseConflictError> =>
  Effect.tryPromise({
    try: () => readStableEvidenceSource(leasePath),
    catch: (error) =>
      error instanceof TransitionalEvidenceError
        ? conflict(
            "transitional",
            "A writer lease contains transitional ownership evidence; ownership remains locked for manual recovery.",
          )
        : conflict(
            "corrupt",
            "A writer lease exists, but its bounded ownership evidence could not be read stably; ownership is uncertain and remains locked.",
          ),
  }).pipe(
    Effect.flatMap((stable) =>
      Effect.try({
        try: () => ({ stable, value: JSON.parse(stable.source) as unknown }),
        catch: () =>
          conflict(
            "corrupt",
            "A writer lease contains malformed ownership evidence; ownership is uncertain and remains locked.",
          ),
      }),
    ),
    Effect.flatMap(({ stable, value }) =>
      Schema.decodeUnknownEffect(WriterLeaseEvidenceSchema)(value).pipe(
        Effect.mapError(() =>
          conflict(
            "corrupt",
            "A writer lease contains invalid ownership evidence; ownership is uncertain and remains locked.",
          ),
        ),
        Effect.map((evidence) => ({ ...stable, evidence })),
      ),
    ),
  );

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await fs.open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const ensureLeaseRoot = (root: string): Effect.Effect<void, WriterLeaseAcquireError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700);
    },
    catch: () =>
      new WriterLeaseAcquireError({
        message: "Unable to prepare private writer-lease state; writer startup was denied.",
      }),
  });

const createLeaseDirectory = (leasePath: string): Effect.Effect<boolean, WriterLeaseAcquireError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await fs.mkdir(leasePath, { mode: 0o700 });
        return true;
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") return false;
        throw error;
      }
    },
    catch: () =>
      new WriterLeaseAcquireError({
        message: "Unable to acquire private writer-lease state; writer startup was denied.",
      }),
  });

const writeOwnedEvidence = (
  root: string,
  leasePath: string,
  evidence: WriterLeaseEvidence,
): Effect.Effect<void, WriterLeaseAcquireError> =>
  Effect.tryPromise({
    try: async () => {
      const source = `${JSON.stringify(evidence)}\n`;
      if (Buffer.byteLength(source, "utf8") > MAX_EVIDENCE_BYTES) throw new Error("size");
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(
          evidencePath(leasePath),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        await handle.writeFile(source, { encoding: "utf8" });
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(leasePath);
        await syncDirectory(root);
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        try {
          await fs.rm(leasePath, { recursive: true, force: false });
          await syncDirectory(root);
        } catch {
          throw new Error("cleanup-unconfirmed");
        }
        throw error;
      }
    },
    catch: () =>
      new WriterLeaseAcquireError({
        message:
          "Writer-lease evidence could not be committed or its failed acquisition could not be cleaned up; writer startup was denied and any remaining state stays fail-closed.",
      }),
  });

const verifyMovedEvidence = (
  path: string,
  expected: WriterLeaseEvidence,
  message: string,
): Effect.Effect<void, WriterLeaseConflictError> =>
  readEvidence(path).pipe(
    Effect.flatMap(({ evidence }) =>
      evidence.ownershipToken === expected.ownershipToken &&
      evidence.filesystemIdentityDigest === expected.filesystemIdentityDigest &&
      evidence.phase === expected.phase
        ? Effect.void
        : Effect.fail(conflict("uncertain", message, evidence)),
    ),
  );

const claimDeadReservedLease = (
  root: string,
  leasePath: string,
  evidence: WriterLeaseEvidence,
): Effect.Effect<boolean, WriterLeaseConflictError> => {
  // Release and takeover deliberately use the same deterministic, non-empty old-token destination.
  // Any late operation for that owner therefore cannot rename a replacement lease after an ABA cycle.
  const orphanPath = tombstonePath(leasePath, evidence.ownershipToken);
  return Effect.tryPromise({
    try: async () => {
      try {
        await fs.rename(leasePath, orphanPath);
        return true;
      } catch (error) {
        const code = nodeErrorCode(error);
        if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
        throw error;
      }
    },
    catch: () =>
      conflict(
        "uncertain",
        "A dead reserved writer lease could not be claimed atomically; ownership remains uncertain and locked.",
        evidence,
      ),
  }).pipe(
    Effect.flatMap((claimed) =>
      claimed
        ? verifyMovedEvidence(
            orphanPath,
            evidence,
            "Moved dead-reservation evidence did not retain the expected ownership token; ownership remains uncertain.",
          ).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => syncDirectory(root),
                catch: () =>
                  conflict(
                    "uncertain",
                    "Dead-reservation takeover could not be durably confirmed; ownership remains uncertain.",
                    evidence,
                  ),
              }),
            ),
            Effect.as(true),
          )
        : Effect.succeed(false),
    ),
  );
};

const validFilesystemIdentity = (cwd: CanonicalWriterCwd): boolean =>
  cwd.filesystemIdentity.length >= 1 &&
  cwd.filesystemIdentity.length <= MAX_FILESYSTEM_IDENTITY_CHARS &&
  FILESYSTEM_IDENTITY_PATTERN.test(cwd.filesystemIdentity) &&
  DIGEST_PATTERN.test(cwd.digest) &&
  digest(cwd.filesystemIdentity) === cwd.digest;

export const makeWriterLease = (options: WriterLeaseLayerOptions): WriterLeaseShape => {
  const root = writerLeaseRoot(options.agentDirectory);
  const platform = options.platform ?? process.platform;
  const parentPid = options.parentPid ?? process.pid;
  const parentProcessStartedAtMillis =
    options.parentProcessStartedAtMillis ??
    Math.max(0, Math.floor(Date.now() - process.uptime() * 1_000));
  const ownerNonce = options.ownerNonce ?? randomToken();
  const nowMillis = options.nowMillis ?? Date.now;
  const nextToken = options.randomToken ?? randomToken;
  const probeOwner = options.probeOwner ?? probeProcess;

  const canonicalize: WriterLeaseShape["canonicalize"] = (cwd) =>
    Effect.tryPromise({
      try: async () => {
        const path = await fs.realpath(cwd);
        const stat = await fs.stat(path, { bigint: true });
        if (!stat.isDirectory()) throw new Error("not-directory");
        const filesystemIdentity = `dev:${stat.dev.toString(16)};ino:${stat.ino.toString(16)}`;
        if (
          filesystemIdentity.length > MAX_FILESYSTEM_IDENTITY_CHARS ||
          !FILESYSTEM_IDENTITY_PATTERN.test(filesystemIdentity)
        )
          throw new Error("identity");
        return { path, filesystemIdentity, digest: digest(filesystemIdentity) };
      },
      catch: () =>
        new WriterCwdCanonicalizationError({
          message:
            "Writer cwd could not be resolved to a stable existing local-directory identity; no writer backend was started.",
        }),
    });

  const acquire: WriterLeaseShape["acquire"] = (request) =>
    Effect.gen(function* () {
      if (
        platform === "win32" ||
        !validFilesystemIdentity(request.cwd) ||
        request.sessionId.length < 1 ||
        request.sessionId.length > MAX_ID_CHARS ||
        request.runId.length < 1 ||
        request.runId.length > MAX_ID_CHARS ||
        !Number.isSafeInteger(parentPid) ||
        parentPid <= 0 ||
        !DIGEST_PATTERN.test(ownerNonce)
      )
        return yield* new WriterLeaseAcquireError({
          message:
            "Writer-lease ownership input or platform was invalid; writer startup was denied.",
        });

      yield* ensureLeaseRoot(root);
      const ownershipToken = nextToken();
      if (!DIGEST_PATTERN.test(ownershipToken))
        return yield* new WriterLeaseAcquireError({
          message: "Writer-lease ownership token generation failed; writer startup was denied.",
        });
      const evidence: WriterLeaseEvidence = {
        version: LEASE_VERSION,
        phase: "reserved",
        ownershipToken,
        filesystemIdentityDigest: request.cwd.digest,
        parentPid,
        parentProcessStartedAtMillis,
        ownerNonce,
        sessionId: request.sessionId,
        runId: request.runId,
        acquiredAtMillis: Math.max(0, Math.floor(nowMillis())),
      };
      const path = writerLeasePath(options.agentDirectory, request.cwd.digest);
      let created = yield* createLeaseDirectory(path);
      if (!created) {
        const existing = (yield* readEvidence(path)).evidence;
        if (existing.filesystemIdentityDigest !== request.cwd.digest)
          return yield* conflict(
            "corrupt",
            "Writer-lease filesystem identity does not match its hashed slot; ownership remains locked.",
            existing,
          );
        const liveness = probeOwner(existing.parentPid);
        if (liveness === "alive")
          return yield* conflict(
            "live",
            `Writer ${existing.runId} in parent session ${existing.sessionId} already owns this filesystem directory identity.`,
            existing,
          );
        if (liveness !== "dead")
          return yield* conflict(
            "uncertain",
            "The existing writer owner could not be proven dead; ownership remains locked.",
            existing,
          );
        if (existing.phase !== "reserved")
          return yield* conflict(
            "spawn-started",
            "The writer parent is dead but backend spawn had started; automatic reclaim is forbidden until external backend death is verified and private state is recovered manually.",
            existing,
          );
        const claimed = yield* claimDeadReservedLease(root, path, existing);
        if (!claimed)
          return yield* conflict(
            "contended",
            "Another contender changed or claimed the dead reserved writer lease; writer startup was denied.",
            existing,
          );
        created = yield* createLeaseDirectory(path);
        if (!created)
          return yield* conflict(
            "contended",
            "Another contender acquired the filesystem directory identity during orphan takeover.",
            existing,
          );
      }
      yield* writeOwnedEvidence(root, path, evidence);
      return {
        canonicalCwd: request.cwd.path,
        filesystemIdentityDigest: request.cwd.digest,
        leasePath: path,
        ownershipToken,
        evidence,
      } satisfies WriterLease;
    }).pipe(Effect.uninterruptible);

  const markSpawnStarted: WriterLeaseShape["markSpawnStarted"] = (lease) =>
    Effect.gen(function* () {
      const expectedPath = writerLeasePath(options.agentDirectory, lease.filesystemIdentityDigest);
      if (
        platform === "win32" ||
        lease.leasePath !== expectedPath ||
        !DIGEST_PATTERN.test(lease.filesystemIdentityDigest) ||
        !DIGEST_PATTERN.test(lease.ownershipToken)
      )
        return yield* new WriterLeaseMarkError({
          message:
            "Writer-lease spawn transition ownership evidence was invalid; no backend spawn is permitted.",
        });
      const current = yield* readEvidence(lease.leasePath).pipe(
        Effect.mapError(
          (error) =>
            new WriterLeaseMarkError({
              message: `${error.message} No backend spawn is permitted.`,
            }),
        ),
      );
      if (
        current.evidence.ownershipToken !== lease.ownershipToken ||
        current.evidence.filesystemIdentityDigest !== lease.filesystemIdentityDigest
      )
        return yield* new WriterLeaseMarkError({
          message:
            "Writer-lease spawn transition token did not match; no backend spawn is permitted.",
        });
      if (current.evidence.phase === "spawn-started")
        return { ...lease, evidence: current.evidence } satisfies WriterLease;

      const startedEvidence: WriterLeaseEvidence = {
        ...current.evidence,
        phase: "spawn-started",
        spawnStartedAtMillis: Math.max(0, Math.floor(nowMillis())),
      };
      yield* Effect.tryPromise({
        try: async () => {
          const source = `${JSON.stringify(startedEvidence)}\n`;
          if (Buffer.byteLength(source, "utf8") > MAX_EVIDENCE_BYTES) throw new Error("size");
          const temporaryPath = transitionPath(lease.leasePath, lease.ownershipToken);
          let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
          try {
            handle = await fs.open(
              temporaryPath,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
              0o600,
            );
            await handle.writeFile(source, { encoding: "utf8" });
            await handle.sync();
            await handle.close();
            handle = undefined;
            const directory = await fs.lstat(lease.leasePath, { bigint: true });
            if (
              directory.dev !== current.directoryDevice ||
              directory.ino !== current.directoryInode
            )
              throw new Error("directory-changed");
            await fs.rename(temporaryPath, evidencePath(lease.leasePath));
            await syncDirectory(lease.leasePath);
          } catch (error) {
            if (handle) await handle.close().catch(() => undefined);
            // A transition artifact is intentionally retained. Its presence makes dead-owner
            // inspection transitional/fail-closed rather than misclassifying the old reservation.
            throw error;
          }
        },
        catch: () =>
          new WriterLeaseMarkError({
            message:
              "Writer-lease spawn-started evidence could not be committed durably; no backend spawn is permitted and ownership remains fail-closed.",
          }),
      });
      const confirmed = yield* readEvidence(lease.leasePath).pipe(
        Effect.mapError(
          (error) =>
            new WriterLeaseMarkError({
              message: `${error.message} The spawn transition is ambiguous, so no backend spawn is permitted.`,
            }),
        ),
      );
      if (
        confirmed.directoryDevice !== current.directoryDevice ||
        confirmed.directoryInode !== current.directoryInode ||
        confirmed.evidence.ownershipToken !== lease.ownershipToken ||
        confirmed.evidence.filesystemIdentityDigest !== lease.filesystemIdentityDigest ||
        confirmed.evidence.phase !== "spawn-started"
      )
        return yield* new WriterLeaseMarkError({
          message:
            "Writer-lease spawn-started evidence could not be ownership-confirmed; no backend spawn is permitted.",
        });
      return { ...lease, evidence: confirmed.evidence } satisfies WriterLease;
    }).pipe(Effect.uninterruptible);

  const release: WriterLeaseShape["release"] = (lease) =>
    Effect.gen(function* () {
      const expectedPath = writerLeasePath(options.agentDirectory, lease.filesystemIdentityDigest);
      if (
        lease.leasePath !== expectedPath ||
        !DIGEST_PATTERN.test(lease.filesystemIdentityDigest) ||
        !DIGEST_PATTERN.test(lease.ownershipToken)
      )
        return yield* new WriterLeaseReleaseError({
          message: "Writer-lease release ownership evidence was invalid; the lease remains locked.",
        });
      const current = yield* readEvidence(lease.leasePath).pipe(
        Effect.mapError(
          () =>
            new WriterLeaseReleaseError({
              message:
                "Writer-lease ownership could not be confirmed during release; the lease remains fail-closed.",
            }),
        ),
      );
      if (
        current.evidence.ownershipToken !== lease.ownershipToken ||
        current.evidence.filesystemIdentityDigest !== lease.filesystemIdentityDigest
      )
        return yield* new WriterLeaseReleaseError({
          message: "Writer-lease ownership token did not match; the lease remains locked.",
        });
      if (options.beforeReleaseRename)
        yield* Effect.tryPromise({
          try: options.beforeReleaseRename,
          catch: () =>
            new WriterLeaseReleaseError({
              message: "Writer-lease release synchronization failed; the lease remains locked.",
            }),
        });

      const releasedPath = tombstonePath(lease.leasePath, lease.ownershipToken);
      yield* Effect.tryPromise({
        try: () => fs.rename(lease.leasePath, releasedPath),
        catch: () =>
          new WriterLeaseReleaseError({
            message:
              "Writer-lease release tombstone could not be committed; the slot was not considered released.",
          }),
      });
      const moved = yield* readEvidence(releasedPath).pipe(
        Effect.mapError(
          () =>
            new WriterLeaseReleaseError({
              message:
                "Moved writer-lease release evidence could not be read stably; release remains ownership-uncertain.",
            }),
        ),
      );
      if (
        moved.evidence.ownershipToken !== lease.ownershipToken ||
        moved.evidence.filesystemIdentityDigest !== lease.filesystemIdentityDigest
      )
        return yield* new WriterLeaseReleaseError({
          message:
            "Moved writer-lease release evidence did not retain the expected token; release remains ownership-uncertain.",
        });
      yield* Effect.tryPromise({
        try: () => syncDirectory(root),
        catch: () =>
          new WriterLeaseReleaseError({
            message:
              "Writer-lease release tombstone could not be durably confirmed; release remains ownership-uncertain.",
          }),
      });
    }).pipe(Effect.uninterruptible);

  return { platform, canonicalize, acquire, markSpawnStarted, release };
};

export class WriterLeaseService extends Context.Service<WriterLeaseService, WriterLeaseShape>()(
  "pi-subagents/boundary/writer-lease/WriterLeaseService",
) {
  static readonly layer = (options: WriterLeaseLayerOptions): Layer.Layer<WriterLeaseService> =>
    Layer.succeed(this, makeWriterLease(options));
}
