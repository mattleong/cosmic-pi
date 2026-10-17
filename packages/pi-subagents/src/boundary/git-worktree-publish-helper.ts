import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nodeFsConstants as constants } from "./node-builtins.ts";
const fs = process.getBuiltinModule("node:fs");
if (!fs) throw new Error("Node filesystem unavailable");

export const publicationInputLimit = 48 * 1024 * 1024;
export const publicationBackupPrefix = ".pi-workspace-old-";
export const publicationTemporaryPrefix = ".pi-workspace-new-";
const image = Schema.Struct({ bytes: Schema.String, mode: Schema.Finite });
const publicationRequestSchema = Schema.Struct({
  directoryDev: Schema.Finite,
  directoryIno: Schema.Finite,
  name: Schema.String,
  backupName: Schema.String,
  temporaryName: Schema.String,
  before: Schema.optional(image),
  after: Schema.optional(image),
});
export type PublicationWireRequest = typeof publicationRequestSchema.Type;
const directoryRequestSchema = Schema.Struct({
  operation: Schema.Literal("mkdir"),
  directoryDev: Schema.Finite,
  directoryIno: Schema.Finite,
  name: Schema.String,
});
export type DirectoryWireRequest = typeof directoryRequestSchema.Type;
export const directoryResultSchema = Schema.Struct({
  directoryDev: Schema.Finite,
  directoryIno: Schema.Finite,
});
const backupRemovalRequestSchema = Schema.Struct({
  operation: Schema.Literal("remove-backups"),
  directoryDev: Schema.Finite,
  directoryIno: Schema.Finite,
  names: Schema.Array(Schema.String),
});
export type BackupRemovalWireRequest = typeof backupRemovalRequestSchema.Type;
export const backupRemovalResultSchema = Schema.Struct({ retained: Schema.Array(Schema.String) });
const directoryRemovalRequestSchema = Schema.Struct({
  operation: Schema.Literal("rmdir"),
  directoryDev: Schema.Finite,
  directoryIno: Schema.Finite,
  name: Schema.String,
  targetDev: Schema.Finite,
  targetIno: Schema.Finite,
});
export type DirectoryRemovalWireRequest = typeof directoryRemovalRequestSchema.Type;
export const directoryRemovalResultSchema = Schema.Struct({ removed: Schema.Boolean });
const inputSchema = Schema.Union([
  directoryRequestSchema,
  backupRemovalRequestSchema,
  directoryRemovalRequestSchema,
  publicationRequestSchema,
]);
export const publicationResultSchema = Schema.Struct({
  status: Schema.Literals(["success", "conflict", "uncertain"]),
  reason: Schema.Literals([
    "published",
    "invalid-request",
    "directory-changed",
    "target-changed",
    "destination-exists",
    "io-failure",
  ]),
  captured: Schema.Boolean,
});
type PublicationResult = typeof publicationResultSchema.Type;
const validLeaf = (name: string) =>
  name !== "." &&
  name !== ".." &&
  name.length > 0 &&
  Buffer.byteLength(name) <= 255 &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0");
const validImage = (value: PublicationWireRequest["before"]) =>
  value === undefined ||
  (Number.isInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777 &&
    value.bytes.length <= publicationInputLimit &&
    Buffer.from(value.bytes, "base64").toString("base64") === value.bytes);
type Anchor = Pick<PublicationWireRequest, "directoryDev" | "directoryIno">;
const validAnchor = (r: Anchor) =>
  [r.directoryDev, r.directoryIno].every((n) => Number.isSafeInteger(n) && n >= 0);
const validRequest = (r: PublicationWireRequest) =>
  validAnchor(r) &&
  [r.name, r.backupName, r.temporaryName].every(validLeaf) &&
  new Set([r.name, r.backupName, r.temporaryName]).size === 3 &&
  [r.backupName, r.temporaryName].every((name) => name.startsWith(".pi-workspace-")) &&
  validImage(r.before) &&
  validImage(r.after) &&
  (r.before !== undefined || r.after !== undefined);
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const exists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));
const inspect = (name: string) => {
  try {
    return fs.lstatSync(name);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
};

type PublicationImage = NonNullable<PublicationWireRequest["before"]>;
type FileStat = ReturnType<typeof fs.fstatSync>;

const readFully = (file: number, size: number) => {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(file, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return { bytes, offset };
};

const openedCaptureMatches = (file: number, stat: FileStat, before: PublicationImage) => {
  const opened = fs.fstatSync(file);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    opened.dev !== stat.dev ||
    opened.ino !== stat.ino ||
    opened.size !== Buffer.from(before.bytes, "base64").length
  )
    return false;
  const { bytes, offset } = readFully(file, opened.size);
  const final = fs.fstatSync(file);
  const matches =
    offset === bytes.length &&
    final.size === opened.size &&
    bytes.equals(Buffer.from(before.bytes, "base64")) &&
    (final.mode & 0o7777) === before.mode &&
    final.nlink === 1 &&
    final.mtimeMs === opened.mtimeMs &&
    final.ctimeMs === opened.ctimeMs;
  fs.fsyncSync(file);
  return matches;
};

const capturedMatches = (backupName: string, before: PublicationImage) => {
  const stat = fs.lstatSync(backupName);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { stat, matches: false };
  const file = fs.openSync(
    backupName,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    return { stat, matches: openedCaptureMatches(file, stat, before) };
  } finally {
    fs.closeSync(file);
  }
};

const anchorMatches = (r: Anchor) => {
  const directory = fs.statSync(".");
  return (
    directory.isDirectory() && directory.dev === r.directoryDev && directory.ino === r.directoryIno
  );
};
const syncDirectory = () => {
  const fd = fs.openSync(".", constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const eligibleTarget = (r: PublicationWireRequest) => {
  const target = inspect(r.name);
  if (r.before === undefined) return target === undefined;
  return target !== undefined && target.isFile() && !target.isSymbolicLink() && target.nlink === 1;
};
const artifactsExist = (r: PublicationWireRequest) =>
  inspect(r.backupName) !== undefined || inspect(r.temporaryName) !== undefined;
const writeTemporary = (name: string, after: PublicationImage) => {
  const temporary = fs.openSync(name, "wx", 0o600);
  try {
    fs.writeFileSync(temporary, Buffer.from(after.bytes, "base64"));
    fs.fchmodSync(temporary, after.mode);
    fs.fsyncSync(temporary);
  } finally {
    fs.closeSync(temporary);
  }
};
// Only for a definite conflict: the temporary file was never linked to the target, so it holds
// nothing recovery needs.
const discardTemporary = (r: PublicationWireRequest) => {
  if (r.after === undefined) return;
  try {
    fs.unlinkSync(r.temporaryName);
  } catch {}
};
// The exclusive link never clobbers a file that appeared meanwhile. Once both names hold the same
// file, dropping the backup name leaves the original exactly as it was found, rather than
// hard-linked to a backup that later captures refuse and in-place edits would change too.
const restoreUnmatchedCapture = (r: PublicationWireRequest, stat: FileStat) => {
  if (stat.isFile() && !stat.isSymbolicLink()) {
    try {
      fs.linkSync(r.backupName, r.name);
      const restored = fs.lstatSync(r.name);
      const backup = fs.lstatSync(r.backupName);
      if (restored.dev === backup.dev && restored.ino === backup.ino) fs.unlinkSync(r.backupName);
    } catch {}
  }
  discardTemporary(r);
  syncDirectory();
};
const installPublished = (r: PublicationWireRequest): "published" | "destination-exists" => {
  if (r.after !== undefined) {
    try {
      fs.linkSync(r.temporaryName, r.name);
      fs.unlinkSync(r.temporaryName);
    } catch (error) {
      if (exists(error)) {
        discardTemporary(r);
        syncDirectory();
        return "destination-exists";
      }
      syncDirectory();
      throw error;
    }
  } else if (inspect(r.name)) {
    syncDirectory();
    return "destination-exists";
  }
  syncDirectory();
  return "published";
};

export const executePublication = (
  r: PublicationWireRequest,
  hooks?: {
    readonly anchored?: () => void;
    readonly captured?: () => void;
  },
) =>
  Effect.try({
    try: (): PublicationResult => {
      let captured = false;
      const result = (
        status: PublicationResult["status"],
        reason: PublicationResult["reason"],
      ): PublicationResult => ({ status, reason, captured });
      if (!validRequest(r)) return result("conflict", "invalid-request");
      try {
        if (!anchorMatches(r)) return result("conflict", "directory-changed");
        hooks?.anchored?.();
        if (!eligibleTarget(r)) return result("conflict", "target-changed");
        if (artifactsExist(r)) return result("conflict", "destination-exists");
        if (r.after !== undefined) writeTemporary(r.temporaryName, r.after);
        if (r.before !== undefined) {
          const reservation = fs.openSync(r.backupName, "wx", 0o600);
          fs.closeSync(reservation);
          fs.renameSync(r.name, r.backupName);
          captured = true;
          syncDirectory();
          const { stat, matches } = capturedMatches(r.backupName, r.before);
          if (!matches) {
            restoreUnmatchedCapture(r, stat);
            return result("conflict", "target-changed");
          }
          hooks?.captured?.();
        }
        return installPublished(r) === "published"
          ? result("success", "published")
          : result("conflict", "destination-exists");
      } catch {
        return result("uncertain", "io-failure");
      }
    },
    catch: () => new PublicationHelperError(),
  });

class PublicationHelperError extends Schema.TaggedError<PublicationHelperError>()(
  "PublicationHelperError",
  {},
) {}

const createDirectory = (r: DirectoryWireRequest) =>
  Effect.try({
    try: () => {
      if (!validLeaf(r.name) || !validAnchor(r)) throw new Error("invalid input");
      if (!anchorMatches(r)) throw new Error("directory changed");
      fs.mkdirSync(r.name, { mode: 0o755 });
      const created = fs.lstatSync(r.name);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("directory changed");
      syncDirectory();
      return { directoryDev: created.dev, directoryIno: created.ino };
    },
    catch: () => new PublicationHelperError(),
  });

// A name that is no longer a regular file was replaced by someone else, so it stays.
const removeBackup = (name: string) => {
  try {
    const stat = inspect(name);
    if (stat === undefined) return true;
    if (!stat.isFile()) return false;
    fs.unlinkSync(name);
    return true;
  } catch {
    return false;
  }
};

const removeBackups = (r: BackupRemovalWireRequest) =>
  Effect.try({
    try: () => {
      if (
        !validAnchor(r) ||
        !r.names.every((name) => validLeaf(name) && name.startsWith(publicationBackupPrefix))
      )
        throw new Error("invalid input");
      if (!anchorMatches(r)) return { retained: r.names };
      const retained = r.names.filter((name) => !removeBackup(name));
      syncDirectory();
      return { retained };
    },
    catch: () => new PublicationHelperError(),
  });

// Non-recursive: a directory that isn't empty, or is no longer the one publication saw, stays.
const removeDirectory = (r: DirectoryRemovalWireRequest) =>
  Effect.try({
    try: () => {
      if (
        !validLeaf(r.name) ||
        !validAnchor(r) ||
        !validAnchor({ directoryDev: r.targetDev, directoryIno: r.targetIno })
      )
        throw new Error("invalid input");
      if (!anchorMatches(r)) return { removed: false };
      const target = inspect(r.name);
      if (
        target === undefined ||
        !target.isDirectory() ||
        target.dev !== r.targetDev ||
        target.ino !== r.targetIno
      )
        return { removed: false };
      try {
        fs.rmdirSync(r.name);
      } catch {
        return { removed: false };
      }
      syncDirectory();
      return { removed: true };
    },
    catch: () => new PublicationHelperError(),
  });

const handleRequest = (request: typeof inputSchema.Type) => {
  if (!("operation" in request)) return executePublication(request);
  if (request.operation === "mkdir") return createDirectory(request);
  return request.operation === "rmdir" ? removeDirectory(request) : removeBackups(request);
};

export const publicationMain = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fallback: PublicationResult = {
        status: "uncertain",
        reason: "invalid-request",
        captured: false,
      };
      const output = yield* Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => {
            const chunks: Buffer[] = [];
            let size = 0;
            while (true) {
              const chunk = Buffer.alloc(65536);
              const count = fs.readSync(0, chunk, 0, chunk.length, null);
              if (count === 0) break;
              size += count;
              if (size > publicationInputLimit) throw new Error("bounded input");
              chunks.push(chunk.subarray(0, count));
            }
            return Buffer.concat(chunks).toString("utf8");
          },
          catch: () => new PublicationHelperError(),
        });
        const request = yield* Schema.decodeEffect(Schema.fromJsonString(inputSchema))(input);
        return yield* handleRequest(request);
      }).pipe(Effect.orElseSucceed(() => fallback));
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Union([
            publicationResultSchema,
            directoryResultSchema,
            backupRemovalResultSchema,
            directoryRemovalResultSchema,
          ]),
        ),
      )(output);
      yield* Effect.try({
        try: () => process.stdout.write(encoded),
        catch: () => new PublicationHelperError(),
      });
    }),
  );
