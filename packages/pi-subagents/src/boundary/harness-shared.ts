import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import {
  hasControlCharacter,
  hasObjectRuntimeType,
  nodeFsPromises as fs,
  nodePath,
  PrivateFileError,
  tryPrivateFileOperation,
} from "pi-cosmic-core";
import { homedir } from "node:os";
import { decodeUnknownJsonOption } from "./wire-shared.ts";

const MAX_AUTH_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 4_096;

export const tomlString = (value: string): string => JSON.stringify(value);

export const nodeErrorCode = (cause: unknown): string | undefined =>
  cause && hasObjectRuntimeType(cause) && "code" in cause && Predicate.isString(cause.code)
    ? cause.code
    : undefined;

const unsafeEntry = () => new PrivateFileError({ reason: "unsafe" });

const isRealDirectory = (path: string): Effect.Effect<boolean, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.lstat(path)).pipe(
    Effect.map((stat) => stat.isDirectory() && !stat.isSymbolicLink()),
  );

/** The canonical path of an absolute agent directory that is a real directory, never a link. */
export const safeAgentDirectory = Effect.fn("HarnessShared.safeAgentDirectory")(function* (
  agentDirectory: string,
): Effect.fn.Return<string, PrivateFileError> {
  if (
    !nodePath.isAbsolute(agentDirectory) ||
    agentDirectory.length > MAX_PATH_CHARS ||
    hasControlCharacter(agentDirectory)
  )
    return yield* unsafeEntry();
  const requested = nodePath.resolve(agentDirectory);
  if (!(yield* isRealDirectory(requested))) return yield* unsafeEntry();
  const canonical = yield* tryPrivateFileOperation(() => fs.realpath(requested));
  if (!(yield* isRealDirectory(canonical))) return yield* unsafeEntry();
  return canonical;
});

const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);

const boundedJsonValue = (value: Schema.Json, depth = 0): boolean => {
  if (depth > 16) return false;
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (isJsonArray(value))
    return value.length <= 1_024 && value.every((entry) => boundedJsonValue(entry, depth + 1));
  if (!hasObjectRuntimeType(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1_024 &&
    entries.every(([key, entry]) => key.length <= 1_024 && boundedJsonValue(entry, depth + 1))
  );
};

const validatedCodexAuth = (bytes: Buffer): string | undefined => {
  if (bytes.length <= 1 || bytes.length > MAX_AUTH_BYTES) return undefined;
  const decoded = decodeUnknownJsonOption(bytes.toString("utf8"));
  return Option.isSome(decoded) &&
    Predicate.isObject(decoded.value) &&
    boundedJsonValue(decoded.value)
    ? `${JSON.stringify(decoded.value)}\n`
    : undefined;
};

const readValidatedCodexAuthFromHome = (sourceHome: string): Effect.Effect<string | undefined> => {
  const path = nodePath.join(sourceHome, "auth.json");
  return tryPrivateFileOperation(() => fs.lstat(path)).pipe(
    Effect.filterOrFail(
      (stat) =>
        stat.isFile() && !stat.isSymbolicLink() && stat.size > 1 && stat.size <= MAX_AUTH_BYTES,
      unsafeEntry,
    ),
    Effect.andThen(tryPrivateFileOperation(() => fs.readFile(path))),
    Effect.map(validatedCodexAuth),
    Effect.orElseSucceed(() => undefined),
  );
};

/** The user's Codex credential, normalized, or nothing when it is missing, unsafe, or invalid. */
export const readValidatedCodexAuth = (
  sourceEnvironment: NodeJS.ProcessEnv,
): Effect.Effect<string | undefined> =>
  safeAgentDirectory(
    sourceEnvironment.CODEX_HOME ??
      nodePath.join((sourceEnvironment.HOME ?? "") || homedir(), ".codex"),
  ).pipe(
    Effect.flatMap(readValidatedCodexAuthFromHome),
    Effect.orElseSucceed(() => undefined),
  );
