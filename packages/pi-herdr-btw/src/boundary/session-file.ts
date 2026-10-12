import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, synchronousRandomUuid } from "pi-cosmic-core";
import { BoundedId, BoundedPath, parseHerdrBtwSessionId } from "../btw/marker.ts";

const nodeFs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
if (!nodeFs || !nodePath) throw new Error("Node fs/path builtins are unavailable.");
const { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, writeFileSync } =
  nodeFs;
const pathApi = nodePath;

const MAX_SESSION_PATH_CHARS = 4_096;
const MAX_HEADER_LINE_BYTES = 256 * 1024;

const SessionHeaderSchema = Schema.Struct({
  type: Schema.Literal("session"),
  id: BoundedId,
  parentSession: Schema.optional(BoundedPath),
});
const SessionHeaderFromJson = Schema.fromJsonString(SessionHeaderSchema);
const decodeSessionHeader = decodeUnknownOrUndefined(SessionHeaderFromJson);

export type SessionHeaderFacts = Pick<typeof SessionHeaderSchema.Type, "id" | "parentSession">;

export type SessionHeaderProbe =
  | { readonly _tag: "valid"; readonly header: SessionHeaderFacts }
  | { readonly _tag: "invalid" };

export type SessionFileIdentityComparison = "same" | "distinct" | "unavailable";
export type SessionFileIdentityComparator = (
  leftPath: string,
  rightPath: string,
) => SessionFileIdentityComparison;

const LINE_CONTROL = /[\0\r\n]/u;

const isBoundedSessionPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_SESSION_PATH_CHARS &&
  !LINE_CONTROL.test(path) &&
  pathApi.isAbsolute(path);

const withRegularSessionDescriptor = <A>(
  path: string,
  use: (descriptor: number) => A,
): A | undefined => {
  if (!isBoundedSessionPath(path)) return undefined;
  let descriptor: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return undefined;
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
      } catch {}
  }
};

export const compareSessionFileIdentity: SessionFileIdentityComparator = (leftPath, rightPath) => {
  if (!isBoundedSessionPath(leftPath) || !isBoundedSessionPath(rightPath)) return "unavailable";

  const comparison = withRegularSessionDescriptor(pathApi.normalize(leftPath), (leftDescriptor) =>
    withRegularSessionDescriptor(pathApi.normalize(rightPath), (rightDescriptor) => {
      const left = fstatSync(leftDescriptor, { bigint: true });
      const right = fstatSync(rightDescriptor, { bigint: true });
      return left.dev === right.dev && left.ino === right.ino ? "same" : "distinct";
    }),
  );
  return comparison ?? "unavailable";
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

export const probeSessionHeader = (path: string): SessionHeaderProbe => {
  const line = readFirstLine(path);
  const header = line === undefined ? undefined : decodeSessionHeader(line);
  return header
    ? { _tag: "valid", header: { id: header.id, parentSession: header.parentSession } }
    : { _tag: "invalid" };
};

export interface BlankChildSessionFileInput {
  readonly sessionDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}

export type BlankChildSessionFileResult =
  | { readonly _tag: "created"; readonly path: string }
  | { readonly _tag: "invalid" };

export const createChildSessionId = (): string => synchronousRandomUuid();

const createBlankChildSessionFileAt = (
  input: BlankChildSessionFileInput,
  now: number,
): BlankChildSessionFileResult => {
  if (
    !isBoundedSessionPath(input.sessionDir) ||
    parseHerdrBtwSessionId(input.sessionId) === undefined ||
    !pathApi.isAbsolute(input.cwd) ||
    LINE_CONTROL.test(input.cwd)
  )
    return { _tag: "invalid" };
  try {
    if (!statSync(input.sessionDir).isDirectory()) return { _tag: "invalid" };
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
    const fileTimestamp = timestamp.replace(/[:.]/gu, "-");
    const path = pathApi.join(input.sessionDir, `${fileTimestamp}_${input.sessionId}.jsonl`);
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

export const createBlankChildSessionFile = (
  input: BlankChildSessionFileInput,
): Effect.Effect<BlankChildSessionFileResult> =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => createBlankChildSessionFileAt(input, now)));
