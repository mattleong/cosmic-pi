// Real-smoke path identity checks intentionally use Node filesystem canonicalization.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { hasObjectRuntimeType, isStringValue } from "pi-cosmic-core";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const nodeCode = <ErrorInput>(error: ErrorInput): string | undefined =>
  error && hasObjectRuntimeType(error) && "code" in error && isStringValue(error.code)
    ? error.code
    : undefined;

/** Resolve aliases through the deepest existing ancestor without requiring the leaf to exist. */
export const canonicalSmokePath = (input: string): string => {
  let cursor = resolve(input);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      if (nodeCode(error) !== "ENOENT" && nodeCode(error) !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
};

/** Match Herdr 0.8's POSIX config-path precedence. */
export const normalHerdrConfigPath = (environment: NodeJS.ProcessEnv): string =>
  canonicalSmokePath(
    environment.HERDR_CONFIG_PATH ??
      (environment.XDG_CONFIG_HOME
        ? join(environment.XDG_CONFIG_HOME, "herdr", "config.toml")
        : join(environment.HOME ?? homedir(), ".config", "herdr", "config.toml")),
  );

export const validateDisposableHerdrSelection = (
  socket: string,
  configPath: string,
  inheritedEnvironment: NodeJS.ProcessEnv,
) => {
  const inheritedSocket = inheritedEnvironment.HERDR_SOCKET_PATH;
  if (!inheritedSocket)
    throw new Error(
      "Real Herdr smoke requires inherited HERDR_SOCKET_PATH evidence so it can prove the disposable socket is different.",
    );
  const selectedSocket = canonicalSmokePath(socket);
  const selectedConfig = canonicalSmokePath(configPath);
  if (
    selectedSocket === canonicalSmokePath(inheritedSocket) ||
    selectedConfig === normalHerdrConfigPath(inheritedEnvironment)
  )
    throw new Error(
      "Real Herdr smoke refuses the inherited socket or normal Herdr config; use a separate disposable server with isolated XDG homes.",
    );
  return { socket: selectedSocket, configPath: selectedConfig };
};
