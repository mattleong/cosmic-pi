// Shared private-filesystem and harness helpers for boundary services.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { homedir } from "node:os";
import { nodeFsConstants as constants, nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

const { isAbsolute, join, resolve } = nodePath;

export const MAX_AUTH_BYTES = 64 * 1024;
export const MAX_PATH_CHARS = 4_096;

/** Quotes a value as a TOML basic string (Codex config.toml / channel connection.toml). */
export const tomlString = (value: string): string => JSON.stringify(value);

export const nodeErrorCode = <ErrorInput>(error: ErrorInput): string | undefined =>
  error && hasObjectRuntimeType(error) && "code" in error && Predicate.isString(error.code)
    ? error.code
    : undefined;

export const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });

export const ensurePrivateDirectory = (path: string): Promise<void> =>
  fs
    .mkdir(path, { mode: 0o700 })
    .catch((error) => {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    })
    .then(() => fs.lstat(path))
    .then((stat) => {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-private-directory");
      return fs.chmod(path, 0o700);
    });

export const writeExclusive = (path: string, source: string): Promise<void> => {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  return fs
    .open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600)
    .then((handle) =>
      handle
        .writeFile(source, { encoding: "utf8" })
        .then(() => handle.sync())
        .finally(() => handle.close()),
    )
    .then(() => fs.chmod(path, 0o600));
};

export const safeAgentDirectory = (agentDirectory: string): Promise<string> => {
  if (
    !isAbsolute(agentDirectory) ||
    agentDirectory.length < 1 ||
    agentDirectory.length > MAX_PATH_CHARS ||
    hasControlCharacter(agentDirectory)
  )
    return Promise.reject(new Error("invalid-agent-directory"));
  const requested = resolve(agentDirectory);
  return fs
    .lstat(requested)
    .then((requestedStat) => {
      if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink())
        throw new Error("unsafe-agent-directory");
      return fs.realpath(requested);
    })
    .then((canonical) =>
      fs.lstat(canonical).then((canonicalStat) => {
        if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink())
          throw new Error("unsafe-agent-directory");
        return canonical;
      }),
    );
};

export const boundedJsonValue = <ValueInput>(value: ValueInput, depth = 0): boolean => {
  if (depth > 16) return false;
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 1_024 &&
      value.every(<EntryInput>(entry: EntryInput) => boundedJsonValue(entry, depth + 1))
    );
  if (!hasObjectRuntimeType(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1_024 &&
    entries.every(([key, entry]) => key.length <= 1_024 && boundedJsonValue(entry, depth + 1))
  );
};

export const safeCodexSourceHome = (
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const configured = sourceEnvironment.CODEX_HOME;
  const source =
    configured === undefined ? join(sourceEnvironment.HOME || homedir(), ".codex") : configured;
  if (
    !isAbsolute(source) ||
    source.length < 1 ||
    source.length > MAX_PATH_CHARS ||
    hasControlCharacter(source)
  )
    return Promise.resolve(undefined);
  return Promise.resolve()
    .then(() => {
      const requested = resolve(source);
      return fs.lstat(requested).then((requestedStat) => {
        if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) return undefined;
        return fs.realpath(requested).then((canonical) =>
          fs.lstat(canonical).then((canonicalStat) => {
            if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) return undefined;
            return canonical;
          }),
        );
      });
    })
    .catch(() => undefined);
};

const readValidatedCodexAuthFromHome = (sourceHome: string): Promise<string | undefined> => {
  const path = join(sourceHome, "auth.json");
  return fs
    .lstat(path)
    .then((stat) =>
      !stat.isFile() || stat.isSymbolicLink() || stat.size <= 1 || stat.size > MAX_AUTH_BYTES
        ? undefined
        : fs.readFile(path),
    )
    .catch(() => undefined)
    .then((bytes) => {
      if (bytes === undefined || bytes.length <= 1 || bytes.length > MAX_AUTH_BYTES)
        return undefined;
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
        bytes.toString("utf8"),
      );
      if (Option.isNone(decoded)) return undefined;
      const value = decoded.value;
      if (
        !value ||
        !hasObjectRuntimeType(value) ||
        Array.isArray(value) ||
        !boundedJsonValue(value)
      )
        return undefined;
      return `${JSON.stringify(value)}\n`;
    });
};

export const readValidatedCodexAuth = (
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> =>
  safeCodexSourceHome(sourceEnvironment).then((sourceHome) =>
    sourceHome ? readValidatedCodexAuthFromHome(sourceHome) : undefined,
  );
