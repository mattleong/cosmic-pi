// Pi session-file identity and blank-child creation boundary for /herdr-btw.
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Synchronous host-boundary validation needs raw Node fs semantics (lstat and
// O_NOFOLLOW descriptor reads without a scoped Effect runtime); Effect
// FileSystem cannot express this pre-runtime, never-mutating probe contract.
const nodeFs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
const nodeCrypto = process.getBuiltinModule("node:crypto");
if (!nodeFs || !nodePath || !nodeCrypto)
  throw new Error("Node fs/path/crypto builtins are unavailable.");
const { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, writeFileSync } =
  nodeFs;
const { isAbsolute, join } = nodePath;
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

export interface SessionHeaderFacts {
  readonly id: string;
  readonly parentSession?: string | undefined;
}

export type SessionHeaderProbe =
  | { readonly _tag: "valid"; readonly header: SessionHeaderFacts }
  | { readonly _tag: "invalid" };

const INVALID: SessionHeaderProbe = { _tag: "invalid" };

const isBoundedSessionPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_SESSION_PATH_CHARS &&
  !path.includes("\0") &&
  !path.includes("\n") &&
  !path.includes("\r") &&
  isAbsolute(path);

const readFirstLine = (path: string): string | undefined => {
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW closes the lstat TOCTOU window against symlink replacement.
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    if (!fstatSync(descriptor).isFile()) return undefined;
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
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined)
      try {
        closeSync(descriptor);
      } catch {
        // The probe is best-effort and must never escape a close failure.
      }
  }
};

/**
 * Reads only the first header line of a Pi session file with bounded bytes.
 * The probe never follows symlinks, never writes, and never opens the file
 * through SessionManager, so it cannot migrate or rewrite the session.
 */
export const probeSessionHeader = (path: string): SessionHeaderProbe => {
  if (!isBoundedSessionPath(path)) return INVALID;
  try {
    if (!lstatSync(path).isFile()) return INVALID;
  } catch {
    return INVALID;
  }
  const line = readFirstLine(path);
  if (line === undefined) return INVALID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return INVALID;
  }
  const header = Option.getOrUndefined(Schema.decodeUnknownOption(SessionHeaderSchema)(parsed));
  if (!header) return INVALID;
  return { _tag: "valid", header: { id: header.id, parentSession: header.parentSession } };
};

export interface BlankChildSessionFileInput {
  readonly sessionDir: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly timestamp?: string | undefined;
}

export type BlankChildSessionFileResult =
  | { readonly _tag: "created"; readonly path: string }
  | { readonly _tag: "invalid" };

/** Cryptographically strong preassigned child ID compatible with Pi session IDs. */
export const createChildSessionId = (): string => randomUUID();

/**
 * Creates one blank persisted Pi session with exclusive ownership. Starting Pi
 * with `--session` against this header makes even a no-prompt side session
 * resumable immediately; Pi does not flush a brand-new `--session-id` session
 * until its first assistant message.
 */
export const createBlankChildSessionFile = (
  input: BlankChildSessionFileInput,
): BlankChildSessionFileResult => {
  if (
    !isBoundedSessionPath(input.sessionDir) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(input.sessionId) ||
    input.sessionId.length > 128 ||
    !isAbsolute(input.cwd) ||
    input.cwd.includes("\0") ||
    input.cwd.includes("\n") ||
    input.cwd.includes("\r")
  )
    return { _tag: "invalid" };
  try {
    if (!statSync(input.sessionDir).isDirectory()) return { _tag: "invalid" };
    const instant =
      input.timestamp === undefined
        ? DateTime.nowUnsafe()
        : Option.getOrUndefined(DateTime.make(input.timestamp));
    if (instant === undefined) return { _tag: "invalid" };
    const timestamp = DateTime.formatIso(instant);
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
