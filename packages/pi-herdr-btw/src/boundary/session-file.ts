import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  decodeUnknownOrUndefined,
  nodeFs,
  nodePath as pathApi,
  synchronousRandomUuid,
} from "pi-cosmic-core";
import { BoundedId, BoundedPath, parseHerdrBtwSessionId } from "../btw/marker.ts";

const { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, writeFileSync } =
  nodeFs;

const MAX_SESSION_PATH_CHARS = 4_096;
const MAX_HEADER_LINE_BYTES = 256 * 1024;
const HEADER_READ_CHUNK_BYTES = 8 * 1024;

const SessionHeaderSchema = Schema.Struct({
  type: Schema.Literal("session"),
  id: BoundedId,
  parentSession: Schema.optional(BoundedPath),
});
const SessionHeaderFromJson = Schema.fromJsonString(SessionHeaderSchema);
const decodeSessionHeader = decodeUnknownOrUndefined(SessionHeaderFromJson);

export type SessionHeaderFacts = Pick<typeof SessionHeaderSchema.Type, "id" | "parentSession">;

export type SessionHeaderProbe = Data.TaggedEnum<{
  valid: { readonly header: SessionHeaderFacts };
  invalid: Record<never, never>;
}>;
export const SessionHeaderProbe = Data.taggedEnum<SessionHeaderProbe>();

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
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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

  const comparison = withRegularSessionDescriptor(leftPath, (leftDescriptor) =>
    withRegularSessionDescriptor(rightPath, (rightDescriptor) => {
      const left = fstatSync(leftDescriptor, { bigint: true });
      const right = fstatSync(rightDescriptor, { bigint: true });
      return left.dev === right.dev && left.ino === right.ino ? "same" : "distinct";
    }),
  );
  return comparison ?? "unavailable";
};

// Headers are small and transcripts can be large, so the buffer grows only while no newline is
// found. Only bytes past `total` are uninitialized, and they are never read.
const readFirstLine = (path: string): string | undefined =>
  withRegularSessionDescriptor(path, (descriptor) => {
    let buffer = Buffer.allocUnsafe(HEADER_READ_CHUNK_BYTES);
    let total = 0;
    while (total < MAX_HEADER_LINE_BYTES) {
      if (total === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, MAX_HEADER_LINE_BYTES));
        buffer.copy(grown, 0, 0, total);
        buffer = grown;
      }
      const bytes = readSync(descriptor, buffer, total, buffer.length - total, total);
      if (bytes <= 0) break;
      const newline = buffer.subarray(total, total + bytes).indexOf(0x0a);
      if (newline !== -1) return buffer.subarray(0, total + newline).toString("utf8");
      total += bytes;
    }
    if (total < MAX_HEADER_LINE_BYTES) return buffer.subarray(0, total).toString("utf8");
    return undefined;
  });

export const probeSessionHeader = (path: string): SessionHeaderProbe => {
  const line = readFirstLine(path);
  const header = line === undefined ? undefined : decodeSessionHeader(line);
  return header
    ? SessionHeaderProbe.valid({
        header: { id: header.id, parentSession: header.parentSession },
      })
    : SessionHeaderProbe.invalid();
};

export interface BlankChildSessionFileInput {
  readonly sessionDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}

export type BlankChildSessionFileResult = Data.TaggedEnum<{
  created: { readonly path: string };
  invalid: Record<never, never>;
}>;
export const BlankChildSessionFileResult = Data.taggedEnum<BlankChildSessionFileResult>();

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
    return BlankChildSessionFileResult.invalid();
  try {
    if (!statSync(input.sessionDir).isDirectory()) return BlankChildSessionFileResult.invalid();
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
    const fileTimestamp = Fn.pipe(timestamp, Str.replace(/[:.]/gu, "-"));
    const path = pathApi.join(input.sessionDir, `${fileTimestamp}_${input.sessionId}.jsonl`);
    if (!isBoundedSessionPath(path)) return BlankChildSessionFileResult.invalid();
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
    return BlankChildSessionFileResult.created({ path });
  } catch {
    return BlankChildSessionFileResult.invalid();
  }
};

export const createBlankChildSessionFile = (
  input: BlankChildSessionFileInput,
): Effect.Effect<BlankChildSessionFileResult> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => Effect.sync(() => createBlankChildSessionFileAt(input, now))),
  );

export interface HerdrSessionFilesContract {
  readonly probeSessionHeader: (path: string) => Effect.Effect<SessionHeaderProbe>;
  readonly compareSessionFileIdentity: (
    leftPath: string,
    rightPath: string,
  ) => Effect.Effect<SessionFileIdentityComparison>;
  readonly createChildSessionId: Effect.Effect<string>;
  readonly createBlankChildSessionFile: (
    input: BlankChildSessionFileInput,
  ) => Effect.Effect<BlankChildSessionFileResult>;
}

/** Session-file probes for workflows; host callbacks that must stay synchronous use the functions. */
export class HerdrSessionFiles extends Context.Service<
  HerdrSessionFiles,
  HerdrSessionFilesContract
>()("pi-herdr-btw/boundary/session-file/HerdrSessionFiles") {
  static readonly layer: Layer.Layer<HerdrSessionFiles> = Layer.succeed(this, {
    probeSessionHeader: (path) => Effect.sync(() => probeSessionHeader(path)),
    compareSessionFileIdentity: (leftPath, rightPath) =>
      Effect.sync(() => compareSessionFileIdentity(leftPath, rightPath)),
    createChildSessionId: Effect.sync(createChildSessionId),
    createBlankChildSessionFile,
  });
}
