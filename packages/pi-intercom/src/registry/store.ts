import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  processLiveness,
  synchronousRandomHex,
  utf8ByteLength,
  type ProcessIdentity,
} from "pi-cosmic-core";
import {
  createPrivateDirectory,
  currentUserId,
  ensurePrivateDirectory,
  linkEntry,
  listEntries,
  ensureDirectoryPath,
  ownDirectory,
  readPrivateFile,
  removeEmptyDirectory,
  removeOwnEntry,
  renameEntry,
  sameDirectory,
  writePrivateFile,
  type PrivateFileError,
} from "./private-files.ts";
import {
  SessionRecordFromJson,
  SocketOwnerFromJson,
  socketOwner,
  type SessionRecord,
} from "./schema.ts";

const INTERCOM_DIRECTORY = "intercom";
const SESSIONS_DIRECTORY = "sessions";
const SOCKETS_DIRECTORY = "s";
/** Leaves room under the 104-byte macOS and 108-byte Linux `sun_path` limits. */
export const MAX_SOCKET_PATH_BYTES = 100;
/** Names this user's private namespace for fallback socket directories: `pi-intercom-<uid>`. */
export const FALLBACK_NAMESPACE_PREFIX = "pi-intercom-";
const FALLBACK_SOCKET_NAME = "intercom.sock";
const SOCKET_OWNER_FILE = "owner.json";
const TOMBSTONE_SUFFIX = ".tombstone";
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_OWNER_BYTES = 1024;
/** Record files one listing reads; any beyond are left unread. */
const MAX_LISTED_RECORDS = 1024;
/** Fallback socket directories and record tombstones one sweep examines. */
const MAX_SWEPT_ENTRIES = 256;
/** A sweep stops examining owners after this long; the next sweep continues. */
const MAX_SWEEP_MILLIS = 2_000;
/** A fallback socket directory without an owner record is reclaimed once unchanged this long. */
const UNOWNED_DIRECTORY_RETENTION_MILLIS = 24 * 60 * 60 * 1000;
const LIST_CONCURRENCY = 16;
const RECORD_FILE = /^([0-9a-f]{32})\.json$/;
const RECORD_TOMBSTONE = /^\.([0-9a-f]{32})\.json\.[0-9a-f]{16}\.tombstone$/;
const SOCKET_DIRECTORY = /^([0-9a-f]{32})(\.[0-9a-f]{16}\.tombstone)?$/;
/** The entries a fallback socket directory may hold: its socket, owner record, and their writes. */
const SOCKET_DIRECTORY_ENTRY = /^(intercom\.sock|owner\.json|\.owner\.json\.[0-9a-f]{16}\.tmp)$/;

export class IntercomRegistryError extends Schema.TaggedError<IntercomRegistryError>()(
  "IntercomRegistryError",
  { operation: Schema.Literals(["prepare", "write", "remove", "list", "reserve"]) },
) {}

type RegistryOperation = IntercomRegistryError["operation"];

const failAs = (operation: RegistryOperation) =>
  Effect.mapError(() => new IntercomRegistryError({ operation }));

/**
 * `unsafe`: a link, another user's file, a file others may read, or an oversized one;
 * `unreadable`: the OS refused the read; `invalid`: the contents don't decode or name another
 * instance than the file.
 */
export type SkippedRecordReason = "unsafe" | "unreadable" | "invalid";

export interface SkippedRecord {
  readonly file: string;
  readonly reason: SkippedRecordReason;
}

export interface RecordListing {
  readonly records: ReadonlyArray<SessionRecord>;
  /** Record files that couldn't be read or decoded; they stay in place. */
  readonly skipped: ReadonlyArray<SkippedRecord>;
}

export interface SweepResult {
  /** Records of dead owners removed. */
  readonly records: number;
  /** Fallback socket directories of dead owners removed. */
  readonly socketDirectories: number;
}

type RecordRead = Data.TaggedEnum<{
  Found: { readonly record: SessionRecord };
  Vanished: Record<never, never>;
  Skipped: { readonly reason: SkippedRecordReason };
}>;
const RecordRead = Data.taggedEnum<RecordRead>();

/**
 * What a fallback socket directory's owner record shows: an owner of the instance its name
 * carries, no owner record at all, or a record that proves nothing.
 */
type SocketOwnerEvidence = Data.TaggedEnum<{
  Owner: { readonly owner: typeof SocketOwnerFromJson.Type };
  Unowned: Record<never, never>;
  Unproven: Record<never, never>;
}>;
const SocketOwnerEvidence = Data.taggedEnum<SocketOwnerEvidence>();

export interface IntercomRegistryOptions {
  /** Where this user's fallback socket namespace goes when socket paths would be too long. */
  readonly fallbackRoot: string;
}

const ownerIsDead = (owner: { readonly pid: number; readonly started?: string | undefined }) =>
  Effect.sync(() => processLiveness({ pid: owner.pid, started: owner.started }) === "dead");

const decodeRecord = Schema.decodeOption(SessionRecordFromJson);
const decodeOwner = Schema.decodeOption(SocketOwnerFromJson);

const sweepDeadline = Effect.map(Clock.currentTimeMillis, (now) => now + MAX_SWEEP_MILLIS);
const pastDeadline = (until: number) => Effect.map(Clock.currentTimeMillis, (now) => now >= until);

const temporarySuffix = () => Effect.sync(() => synchronousRandomHex(8));

const sameRecord = (left: SessionRecord, right: SessionRecord): boolean =>
  left.instance === right.instance &&
  left.pid === right.pid &&
  left.started === right.started &&
  left.socket === right.socket &&
  left.token === right.token;

/**
 * Owns the intercom registry under `<agentDir>/intercom`: private directories, atomic record
 * replacement, listing, socket path reservation, and the sweep of records whose owner has died.
 * Each record has exactly one writer, the session runtime that generated its instance.
 */
export class IntercomRegistry extends Context.Service<IntercomRegistry>()(
  "pi-intercom/registry/store/IntercomRegistry",
  {
    make: (options: IntercomRegistryOptions) =>
      Effect.gen(function* () {
        const paths = yield* Path.Path;
        const agentDirectory = yield* AgentDirectory;
        const root = paths.join(agentDirectory, INTERCOM_DIRECTORY);
        const sessions = paths.join(root, SESSIONS_DIRECTORY);
        const sockets = paths.join(root, SOCKETS_DIRECTORY);
        const recordPath = (instance: string) => paths.join(sessions, `${instance}.json`);
        const preferredSocketPath = (instance: string) => paths.join(sockets, `${instance}.sock`);
        const fallbackNamespace = Effect.sync(() => {
          const uid = currentUserId();
          return uid === undefined
            ? undefined
            : paths.join(options.fallbackRoot, `${FALLBACK_NAMESPACE_PREFIX}${uid}`);
        });

        /** Makes `<agentDir>/intercom` and one directory in it private, refusing links. */
        const managedDirectory = (directory: string) =>
          Effect.gen(function* () {
            yield* ensureDirectoryPath(agentDirectory);
            yield* ensurePrivateDirectory(root);
            yield* ensurePrivateDirectory(directory);
          }).pipe(failAs("prepare"));

        const temporaryFor = (target: string) =>
          Effect.map(temporarySuffix(), (suffix) =>
            paths.join(paths.dirname(target), `.${paths.basename(target)}.${suffix}.tmp`),
          );

        const write = Effect.fn("IntercomRegistry.write")(function* (record: SessionRecord) {
          const source = yield* Schema.encodeEffect(SessionRecordFromJson)(record).pipe(
            failAs("write"),
          );
          yield* managedDirectory(sessions);
          const target = recordPath(record.instance);
          yield* writePrivateFile(target, yield* temporaryFor(target), source).pipe(
            failAs("write"),
          );
        });

        const remove = Effect.fn("IntercomRegistry.remove")(function* (instance: string) {
          yield* removeOwnEntry(recordPath(instance)).pipe(failAs("remove"));
        });

        const readRecordAt = (path: string) =>
          readPrivateFile(path, MAX_RECORD_BYTES).pipe(Effect.map(decodeRecord));

        const skippedFor = (error: PrivateFileError): RecordRead =>
          error.reason === "missing"
            ? // A record removed after the directory listing belongs to a session that just ended.
              RecordRead.Vanished()
            : RecordRead.Skipped({ reason: error.reason === "failed" ? "unreadable" : "unsafe" });

        const readRecord = (file: string, instance: string) =>
          readRecordAt(paths.join(sessions, file)).pipe(
            Effect.map((record) =>
              Option.isSome(record) && record.value.instance === instance
                ? RecordRead.Found({ record: record.value })
                : RecordRead.Skipped({ reason: "invalid" }),
            ),
            Effect.catch((error) => Effect.succeed(skippedFor(error))),
          );

        const sessionEntries = managedDirectory(sessions).pipe(
          Effect.andThen(listEntries(sessions).pipe(failAs("list"))),
        );

        const list = Effect.fn("IntercomRegistry.list")(function* () {
          const files = yield* sessionEntries;
          const candidates = files
            .flatMap((file) => {
              const instance = RECORD_FILE.exec(file)?.[1];
              return instance === undefined ? [] : [{ file, instance }];
            })
            .slice(0, MAX_LISTED_RECORDS);
          const reads = yield* Effect.forEach(
            candidates,
            ({ file, instance }) =>
              readRecord(file, instance).pipe(Effect.map((read) => ({ file, read }))),
            { concurrency: LIST_CONCURRENCY },
          );
          const records: Array<SessionRecord> = [];
          const skipped: Array<SkippedRecord> = [];
          for (const { file, read } of reads) {
            if (Predicate.isTagged(read, "Found")) records.push(read.record);
            else if (Predicate.isTagged(read, "Skipped"))
              skipped.push({ file, reason: read.reason });
          }
          if (skipped.length > 0)
            yield* Effect.logWarning("Skipped unreadable intercom session records.").pipe(
              Effect.annotateLogs({ skipped: skipped.length }),
            );
          return { records, skipped } satisfies RecordListing;
        });

        /** Removes a socket in the shared socket directory, which is named for its instance. */
        const removeSharedSocket = (record: SessionRecord) =>
          record.socket === preferredSocketPath(record.instance)
            ? Effect.ignore(removeOwnEntry(record.socket))
            : Effect.void;

        /**
         * Moves a dead owner's record aside, so exactly one concurrent sweeper retires it and
         * listings never see a half-removed record, and then checks that the claimed file is the
         * record judged dead before removing it. A record its owner rewrote in between goes back.
         */
        const retireRecord = Effect.fnUntraced(function* (record: SessionRecord) {
          const tombstone = paths.join(
            sessions,
            `.${record.instance}.json.${yield* temporarySuffix()}${TOMBSTONE_SUFFIX}`,
          );
          const claimed = yield* renameEntry(recordPath(record.instance), tombstone).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!claimed) return false;
          const retired = yield* readRecordAt(tombstone).pipe(
            Effect.map((read) => Option.isSome(read) && sameRecord(read.value, record)),
            Effect.orElseSucceed(() => false),
          );
          if (!retired) {
            // Restores it unless its owner has already written a new one.
            yield* linkEntry(tombstone, recordPath(record.instance)).pipe(
              Effect.andThen(removeOwnEntry(tombstone)),
              Effect.ignore,
            );
            return false;
          }
          yield* removeSharedSocket(record);
          yield* Effect.ignore(removeOwnEntry(tombstone));
          return true;
        });

        /** A record tombstone is removed only when it still names a dead owner. */
        const removeRecordTombstone = Effect.fnUntraced(function* (file: string) {
          const path = paths.join(sessions, file);
          const read = yield* readRecordAt(path).pipe(Effect.option, Effect.map(Option.flatten));
          if (Option.isNone(read) || !(yield* ownerIsDead(read.value))) return;
          yield* removeSharedSocket(read.value);
          yield* Effect.ignore(removeOwnEntry(path));
        });

        /** Removes only the entries a socket directory may hold, then the emptied directory. */
        const clearSocketDirectory = Effect.fnUntraced(function* (directory: string) {
          const entries = yield* listEntries(directory);
          if (!entries.every((entry) => SOCKET_DIRECTORY_ENTRY.test(entry))) return false;
          // The owner record goes last: until then the directory still proves whose it was.
          const ordered = [
            ...entries.filter((entry) => entry !== SOCKET_OWNER_FILE),
            ...entries.filter((entry) => entry === SOCKET_OWNER_FILE),
          ];
          for (const entry of ordered) yield* removeOwnEntry(paths.join(directory, entry));
          yield* removeEmptyDirectory(directory);
          return true;
        });

        /** What a socket directory's owner record says, for the instance its name carries. */
        const socketOwnerEvidence = (directory: string, instance: string) =>
          readPrivateFile(paths.join(directory, SOCKET_OWNER_FILE), MAX_OWNER_BYTES).pipe(
            Effect.map((source) => {
              const owner = decodeOwner(source);
              return Option.isSome(owner) && owner.value.instance === instance
                ? SocketOwnerEvidence.Owner({ owner: owner.value })
                : SocketOwnerEvidence.Unproven();
            }),
            Effect.catch((error) =>
              Effect.succeed(
                error.reason === "missing"
                  ? SocketOwnerEvidence.Unowned()
                  : SocketOwnerEvidence.Unproven(),
              ),
            ),
          );

        /**
         * Whether the directory may be reclaimed: its owner record names this instance and a dead
         * owner, or it has no owner record and nothing changed in it for the retention period.
         */
        const reclaimable = Effect.fnUntraced(function* (directory: string, instance: string) {
          const identity = yield* Effect.option(ownDirectory(directory));
          if (Option.isNone(identity)) return Option.none();
          const evidence = yield* socketOwnerEvidence(directory, instance);
          const now = yield* Clock.currentTimeMillis;
          const reclaim = yield* SocketOwnerEvidence.$match(evidence, {
            Owner: ({ owner }) => ownerIsDead(owner),
            Unowned: () =>
              Effect.succeed(
                now - identity.value.modifiedMillis > UNOWNED_DIRECTORY_RETENTION_MILLIS,
              ),
            Unproven: () => Effect.succeed(false),
          });
          return reclaim ? Option.some(identity.value) : Option.none();
        });

        const sweepSocketDirectory = Effect.fnUntraced(function* (
          namespace: string,
          entry: string,
        ) {
          const match = SOCKET_DIRECTORY.exec(entry);
          const instance = match?.[1];
          if (match === null || instance === undefined) return false;
          const directory = paths.join(namespace, entry);
          const judged = yield* reclaimable(directory, instance);
          if (Option.isNone(judged)) return false;
          // A tombstone was already claimed by a sweeper that died before clearing it.
          if (match[2] !== undefined)
            return yield* clearSocketDirectory(directory).pipe(Effect.orElseSucceed(() => false));
          const tombstone = `${directory}.${yield* temporarySuffix()}${TOMBSTONE_SUFFIX}`;
          const claimed = yield* renameEntry(directory, tombstone).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!claimed) return false;
          // The claimed directory must be the one judged, and still be reclaimable.
          const moved = yield* reclaimable(tombstone, instance);
          if (Option.isNone(moved) || !sameDirectory(moved.value, judged.value)) return false;
          return yield* clearSocketDirectory(tombstone).pipe(Effect.orElseSucceed(() => false));
        });

        const sweepSocketDirectories = Effect.fnUntraced(function* (until: number) {
          const namespace = yield* fallbackNamespace;
          if (namespace === undefined) return 0;
          // Only this user's own namespace is swept; a link or another user's directory isn't.
          if (Option.isNone(yield* Effect.option(ownDirectory(namespace)))) return 0;
          const entries = yield* listEntries(namespace).pipe(Effect.orElseSucceed(() => []));
          let removed = 0;
          for (const entry of entries.slice(0, MAX_SWEPT_ENTRIES)) {
            if (yield* pastDeadline(until)) break;
            if (yield* sweepSocketDirectory(namespace, entry)) removed += 1;
          }
          return removed;
        });

        /**
         * Removes records and fallback socket directories whose owner is positively dead: its PID
         * is gone, or now belongs to a process that started at another time. Owners whose
         * liveness is unknown are kept. Each sweep examines a bounded number of entries for a
         * bounded time.
         */
        const sweep = Effect.fn("IntercomRegistry.sweep")(function* () {
          const until = yield* sweepDeadline;
          const { records } = yield* list();
          let retired = 0;
          for (const record of records) {
            if (yield* pastDeadline(until)) break;
            if ((yield* ownerIsDead(record)) && (yield* retireRecord(record))) retired += 1;
          }
          const files = yield* listEntries(sessions).pipe(Effect.orElseSucceed(() => []));
          for (const file of files
            .filter((name) => RECORD_TOMBSTONE.test(name))
            .slice(0, MAX_SWEPT_ENTRIES)) {
            if (yield* pastDeadline(until)) break;
            yield* removeRecordTombstone(file);
          }
          const socketDirectories = yield* sweepSocketDirectories(until);
          return { records: retired, socketDirectories } satisfies SweepResult;
        });

        /**
         * Chooses this runtime's socket path. The shared socket directory is used when the path
         * fits `sun_path`; otherwise a new directory named for the instance, in this user's
         * private fallback namespace, holds the socket beside an owner record, and this scope
         * removes that directory.
         */
        const reserveSocket = Effect.fn("IntercomRegistry.reserveSocket")(function* (
          instance: string,
          owner: ProcessIdentity,
        ) {
          const preferred = preferredSocketPath(instance);
          if (utf8ByteLength(preferred) <= MAX_SOCKET_PATH_BYTES) {
            yield* managedDirectory(sockets);
            return preferred;
          }
          const namespace = yield* fallbackNamespace;
          if (namespace === undefined)
            return yield* new IntercomRegistryError({ operation: "reserve" });
          const directory = paths.join(namespace, instance);
          const socket = paths.join(directory, FALLBACK_SOCKET_NAME);
          if (utf8ByteLength(socket) > MAX_SOCKET_PATH_BYTES)
            return yield* new IntercomRegistryError({ operation: "reserve" });
          yield* ensurePrivateDirectory(namespace).pipe(failAs("reserve"));
          yield* Effect.acquireRelease(
            createPrivateDirectory(directory).pipe(failAs("reserve")),
            () =>
              clearSocketDirectory(directory).pipe(
                Effect.flatMap((cleared) =>
                  cleared ? Effect.void : Effect.logWarning("Kept an intercom socket directory."),
                ),
                Effect.catch(() =>
                  Effect.logWarning("Couldn't remove the intercom socket directory."),
                ),
              ),
          );
          const source = yield* Schema.encodeEffect(SocketOwnerFromJson)(
            socketOwner(instance, owner.pid, owner.started),
          ).pipe(failAs("reserve"));
          const ownerPath = paths.join(directory, SOCKET_OWNER_FILE);
          yield* writePrivateFile(ownerPath, yield* temporaryFor(ownerPath), source).pipe(
            failAs("reserve"),
          );
          return socket;
        });

        return { write, remove, list, sweep, reserveSocket };
      }),
  },
) {
  static readonly layer = (
    options: IntercomRegistryOptions,
  ): Layer.Layer<IntercomRegistry, never, Path.Path | AgentDirectory> =>
    Layer.effect(this, this.make(options));
}
