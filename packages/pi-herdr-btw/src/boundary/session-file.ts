// Pi session-file identity and blank-child creation boundary for /herdr-btw.
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parseHerdrBtwSessionId } from "../btw/marker.ts";

// Synchronous host-boundary validation needs raw Node fs semantics. Effect
// FileSystem cannot express this pre-runtime, never-mutating no-follow probe.
const nodeFs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
const nodeCrypto = process.getBuiltinModule("node:crypto");
if (!nodeFs || !nodePath || !nodeCrypto)
  throw new Error("Node fs/path/crypto builtins are unavailable.");
const { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, writeFileSync } =
  nodeFs;
const { isAbsolute, join, normalize } = nodePath;
const { randomUUID } = nodeCrypto;

const MAX_SESSION_PATH_CHARS = 4_096;
const MAX_HEADER_LINE_BYTES = 256 * 1024;

const SessionHeaderSchema = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  parentSession: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SESSION_PATH_CHARS)),
  ),
});
const SessionHeaderFromJson = Schema.fromJsonString(SessionHeaderSchema);

export type SessionHeaderFacts = Pick<typeof SessionHeaderSchema.Type, "id" | "parentSession">;

export type SessionHeaderProbe =
  | { readonly _tag: "valid"; readonly header: SessionHeaderFacts }
  | { readonly _tag: "invalid" };

export type SessionFileIdentityComparison = "same" | "distinct" | "unavailable";
export type SessionFileIdentityComparator = (
  leftPath: string,
  rightPath: string,
) => SessionFileIdentityComparison;

const INVALID: SessionHeaderProbe = { _tag: "invalid" };
const IDENTITY_UNAVAILABLE: SessionFileIdentityComparison = "unavailable";

const isBoundedSessionPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_SESSION_PATH_CHARS &&
  !path.includes("\0") &&
  !path.includes("\n") &&
  !path.includes("\r") &&
  isAbsolute(path);

const withRegularSessionDescriptor = <A>(
  path: string,
  use: (descriptor: number) => A,
): A | undefined => {
  if (!isBoundedSessionPath(path)) return undefined;
  let descriptor: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return undefined;
    // O_NOFOLLOW closes the path-replacement window against symlinks.
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    if (!fstatSync(descriptor).isFile()) return undefined;
    return use(descriptor);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined)
      try {
        closeSync(descriptor);
      } catch {
        // Read-only validation is best effort and never exposes close failures.
      }
  }
};

/**
 * Compares two regular session files by descriptor identity. Paths are bounded
 * before normalization, and each no-follow open bounds its normalized path
 * again. Any failed probe makes identity unavailable, never evidence that the
 * files are distinct.
 */
export const compareSessionFileIdentity: SessionFileIdentityComparator = (leftPath, rightPath) => {
  if (!isBoundedSessionPath(leftPath) || !isBoundedSessionPath(rightPath))
    return IDENTITY_UNAVAILABLE;

  const comparison = withRegularSessionDescriptor(normalize(leftPath), (leftDescriptor) =>
    withRegularSessionDescriptor(normalize(rightPath), (rightDescriptor) => {
      const left = fstatSync(leftDescriptor, { bigint: true });
      const right = fstatSync(rightDescriptor, { bigint: true });
      return left.dev === right.dev && left.ino === right.ino ? "same" : "distinct";
    }),
  );
  return comparison ?? IDENTITY_UNAVAILABLE;
};

const readFirstLine = (path: string): string | undefined =>
  withRegularSessionDescriptor(path, (descriptor) => {
    const buffer = Buffer.alloc(MAX_HEADER_LINE_BYTES);
    let total = 0;
    while (total < MAX_HEADER_LINE_BYTES) {
      const bytes = readSync(descriptor, buffer, total, MAX_HEADER_LINE_BYTES - total, total);
      if (bytes <= 0) break;
      total += bytes;
      const newline = buffer.subarray(0, total).indexOf(0x0a);
      if (newline !== -1) return buffer.subarray(0, newline).toString("utf8");
    }
    if (total < MAX_HEADER_LINE_BYTES) return buffer.subarray(0, total).toString("utf8");
    return undefined;
  });

/**
 * Reads only the first header line of a Pi session file with bounded bytes.
 * The probe never follows symlinks, never writes, and never opens the file
 * through SessionManager, so it cannot migrate or rewrite the session.
 */
export const probeSessionHeader = (path: string): SessionHeaderProbe => {
  const line = readFirstLine(path);
  if (line === undefined) return INVALID;
  const header = Option.getOrUndefined(Schema.decodeUnknownOption(SessionHeaderFromJson)(line));
  if (!header) return INVALID;
  return { _tag: "valid", header: { id: header.id, parentSession: header.parentSession } };
};

export interface BlankChildSessionFileInput {
  readonly sessionDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}

export type BlankChildSessionFileResult =
  | { readonly _tag: "created"; readonly path: string }
  | { readonly _tag: "invalid" };

/** Cryptographically strong preassigned child ID compatible with Pi session IDs. */
export const createChildSessionId = (): string => randomUUID();

const createBlankChildSessionFileAt = (
  input: BlankChildSessionFileInput,
  now: number,
): BlankChildSessionFileResult => {
  if (
    !isBoundedSessionPath(input.sessionDir) ||
    parseHerdrBtwSessionId(input.sessionId) === undefined ||
    !isAbsolute(input.cwd) ||
    input.cwd.includes("\0") ||
    input.cwd.includes("\n") ||
    input.cwd.includes("\r")
  )
    return { _tag: "invalid" };
  try {
    if (!statSync(input.sessionDir).isDirectory()) return { _tag: "invalid" };
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
    const fileTimestamp = timestamp.replace(/[:.]/gu, "-");
    const path = join(input.sessionDir, `${fileTimestamp}_${input.sessionId}.jsonl`);
    if (!isBoundedSessionPath(path)) return { _tag: "invalid" };
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: input.sessionId,
      timestamp,
      cwd: input.cwd,
    } as const;
    writeFileSync(path, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { _tag: "created", path };
  } catch {
    return { _tag: "invalid" };
  }
};

/**
 * Creates one blank persisted Pi session with exclusive ownership. Starting Pi
 * with `--session` against this header makes even a no-prompt side session
 * resumable immediately; Pi does not flush a brand-new `--session-id` session
 * until its first assistant message.
 */
export const createBlankChildSessionFile = (
  input: BlankChildSessionFileInput,
): Effect.Effect<BlankChildSessionFileResult> =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => createBlankChildSessionFileAt(input, now)));
