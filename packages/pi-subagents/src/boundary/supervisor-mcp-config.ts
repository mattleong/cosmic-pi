import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  MAX_SUPERVISOR_CONFIG_BYTES,
  SupervisorChannelConfigSchema,
  type SupervisorChannelConfig,
} from "../supervisor/protocol.ts";
import { boundedString } from "../supervisor/mcp-wire.ts";
import { nodeFsConstants as constants, nodeFsPromises, nodePath } from "./node-builtins.ts";

const { lstat, open } = nodeFsPromises;
const { dirname, isAbsolute, resolve } = nodePath;

export const configArgument = (argv: ReadonlyArray<string>): string | undefined => {
  const argument = argv[3];
  if (
    argv.length !== 4 ||
    argv[2] !== "--config" ||
    !boundedString(argument, 4096) ||
    !isAbsolute(argument) ||
    argument.includes("\0")
  )
    return undefined;
  return resolve(argument);
};

class HelperConfigError extends Schema.TaggedError<HelperConfigError>()("HelperConfigError", {
  code: Schema.String,
}) {}

const helperConfigError = (code: string) => new HelperConfigError({ code });
const decodeConfigJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(SupervisorChannelConfigSchema),
  { onExcessProperty: "error" },
);

export const readConfig = (
  path: string,
): Effect.Effect<SupervisorChannelConfig, HelperConfigError> =>
  Effect.gen(function* () {
    const directoryStat = yield* Effect.tryPromise({
      try: () => lstat(dirname(path)),
      catch: () => helperConfigError("unsafe-config-directory"),
    });
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0
    )
      return yield* helperConfigError("unsafe-config-directory");
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | noFollow),
        catch: () => helperConfigError("unsafe-config-file"),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: () => helperConfigError("unsafe-config-file"),
          });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SUPERVISOR_CONFIG_BYTES)
            return yield* helperConfigError("unsafe-config-file");
          if ((stat.mode & 0o077) !== 0) return yield* helperConfigError("unsafe-config-mode");
          const source = yield* Effect.tryPromise({
            try: () => handle.readFile({ encoding: "utf8" }),
            catch: () => helperConfigError("invalid-config"),
          });
          if (Buffer.byteLength(source, "utf8") > MAX_SUPERVISOR_CONFIG_BYTES)
            return yield* helperConfigError("oversized-config");
          const decoded = decodeConfigJsonOption(source);
          if (Option.isNone(decoded)) return yield* helperConfigError("invalid-config");
          return decoded.value;
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: () => helperConfigError("config-close-failed"),
        }).pipe(Effect.ignore),
    );
  });
