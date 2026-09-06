import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nodeFsConstants as constants } from "./node-builtins.ts";
// Synchronous syscalls are confined to the killable one-shot child, never the host.
const fs = process.getBuiltinModule("node:fs");
if (!fs) throw new Error("Node filesystem unavailable");

export const publicationInputLimit = 48 * 1024 * 1024;
const image = Schema.Struct({ bytes: Schema.String, mode: Schema.Finite });
export const publicationRequestSchema = Schema.Struct({
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
export const directoryResultSchema = Schema.Struct({
  directoryDev: Schema.Finite,
  directoryIno: Schema.Finite,
});
const inputSchema = Schema.Union([directoryRequestSchema, publicationRequestSchema]);
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
export type PublicationResult = typeof publicationResultSchema.Type;
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
const validRequest = (r: PublicationWireRequest) =>
  [r.directoryDev, r.directoryIno].every((n) => Number.isSafeInteger(n) && n >= 0) &&
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

const capturedMatches = (
  backupName: string,
  before: NonNullable<PublicationWireRequest["before"]>,
) => {
  const stat = fs.lstatSync(backupName);
  let matches = false;
  if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
    const file = fs.openSync(
      backupName,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = fs.fstatSync(file);
      if (
        opened.isFile() &&
        opened.nlink === 1 &&
        opened.dev === stat.dev &&
        opened.ino === stat.ino &&
        opened.size === Buffer.from(before.bytes, "base64").length
      ) {
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.readSync(file, bytes, offset, bytes.length - offset, offset);
          if (count === 0) break;
          offset += count;
        }
        const final = fs.fstatSync(file);
        matches =
          offset === bytes.length &&
          final.size === opened.size &&
          bytes.equals(Buffer.from(before.bytes, "base64")) &&
          (final.mode & 0o7777) === before.mode &&
          final.nlink === 1 &&
          final.mtimeMs === opened.mtimeMs &&
          final.ctimeMs === opened.ctimeMs;
        fs.fsyncSync(file);
      }
    } finally {
      fs.closeSync(file);
    }
  }
  return { stat, matches };
};

const anchorMatches = (r: Pick<PublicationWireRequest, "directoryDev" | "directoryIno">) => {
  const directory = fs.statSync(".");
  return (
    directory.isDirectory() && directory.dev === r.directoryDev && directory.ino === r.directoryIno
  );
};
const eligibleTarget = (r: PublicationWireRequest) => {
  const target = inspect(r.name);
  if (r.before === undefined) return target === undefined;
  return target !== undefined && target.isFile() && !target.isSymbolicLink() && target.nlink === 1;
};
const artifactsExist = (r: PublicationWireRequest) =>
  Boolean(inspect(r.backupName) || inspect(r.temporaryName));

/** Runs only in the one-shot child's anchored cwd. Hooks are test-only, never wire input. */
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
        // cwd is resolved by spawn exactly once. Never use the caller's absolute path again.
        if (!anchorMatches(r)) return result("conflict", "directory-changed");
        hooks?.anchored?.();
        const syncDirectory = () => {
          const fd = fs.openSync(".", constants.O_RDONLY);
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        };
        if (!eligibleTarget(r)) return result("conflict", "target-changed");
        // Exclusive reservations establish ownership. Never clean up by an unowned intention.
        if (artifactsExist(r)) return result("conflict", "destination-exists");
        if (r.after !== undefined) {
          const temporary = fs.openSync(r.temporaryName, "wx", 0o600);
          try {
            fs.writeFileSync(temporary, Buffer.from(r.after.bytes, "base64"));
            fs.fchmodSync(temporary, r.after.mode);
            fs.fsyncSync(temporary);
          } finally {
            fs.closeSync(temporary);
          }
        }
        if (r.before !== undefined) {
          const reservation = fs.openSync(r.backupName, "wx", 0o600);
          fs.closeSync(reservation);
          fs.renameSync(r.name, r.backupName);
          captured = true;
          syncDirectory();
          const { stat, matches } = capturedMatches(r.backupName, r.before);
          if (!matches) {
            // link is exclusive: a concurrent editor's new target is never overwritten.
            // Keep the backup even after restoration for journal-driven recovery.
            // Successful restoration intentionally has nlink=2 until manual recovery removes backup.
            if (stat.isFile() && !stat.isSymbolicLink()) {
              try {
                fs.linkSync(r.backupName, r.name);
              } catch {
                /* Exclusive restoration may lose to an editor. */
              }
            }
            syncDirectory();
            return result("conflict", "target-changed");
          }
          hooks?.captured?.();
        }
        if (r.after !== undefined) {
          try {
            fs.linkSync(r.temporaryName, r.name);
            fs.unlinkSync(r.temporaryName);
          } catch (error) {
            syncDirectory();
            if (exists(error)) return result("conflict", "destination-exists");
            throw error;
          }
        } else if (inspect(r.name)) {
          syncDirectory();
          return result("conflict", "destination-exists");
        }
        syncDirectory();
        return result("success", "published");
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

const createDirectory = (r: typeof directoryRequestSchema.Type) =>
  Effect.try({
    try: () => {
      if (
        !validLeaf(r.name) ||
        ![r.directoryDev, r.directoryIno].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error("invalid input");
      const current = fs.statSync(".");
      if (
        !current.isDirectory() ||
        current.dev !== r.directoryDev ||
        current.ino !== r.directoryIno
      )
        throw new Error("directory changed");
      fs.mkdirSync(r.name, { mode: 0o755 });
      const created = fs.lstatSync(r.name);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("directory changed");
      const directory = fs.openSync(".", constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
      return { directoryDev: created.dev, directoryIno: created.ino };
    },
    catch: () => new PublicationHelperError(),
  });

/** Standalone process entrypoint; this is the only runner, not a session adapter. */
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
        const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(inputSchema))(
          input,
        );
        return "operation" in request
          ? yield* createDirectory(request)
          : yield* executePublication(request);
      }).pipe(Effect.catch(() => Effect.succeed(fallback)));
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Union([publicationResultSchema, directoryResultSchema])),
      )(output);
      yield* Effect.try({
        try: () => process.stdout.write(encoded),
        catch: () => new PublicationHelperError(),
      });
    }),
  );
