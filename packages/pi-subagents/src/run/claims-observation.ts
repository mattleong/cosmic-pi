import { hasObjectRuntimeType, type JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { normalizeWriteClaim } from "../domain/write-claims.ts";

export const MAX_OBSERVED_WRITE_PATHS = 64;
export const MAX_WRITE_CLAIM_VIOLATIONS = 16;
const MAX_NATIVE_CHANGE_PATHS = 256;

const FILE_WRITE_TOOL_NAMES = new Set(["edit", "write", "notebookedit", "applypatch"]);
const PATH_KEYS = ["path", "file_path", "filePath"] as const;
const MOVE_PATH_KEYS = ["move_path", "movePath"] as const;

export const asObject = <ValueInput>(value: ValueInput): Readonly<JsonObject> | undefined => {
  if (value === null || !hasObjectRuntimeType(value) || Array.isArray(value)) return undefined;
  // SAFETY: Runtime guards established a non-null, non-array object before this shallow view.
  return value as ValueInput & Readonly<JsonObject>;
};

export const stringField = (
  value: Readonly<JsonObject> | undefined,
  key: string,
): string | undefined => {
  const field = value?.[key];
  return Predicate.isString(field) && field.trim() ? field.trim() : undefined;
};

/** The named fields of `keys` that hold paths, in key order. */
const pathFields = (value: Readonly<JsonObject> | undefined, keys: ReadonlyArray<string>) =>
  keys.flatMap((key) => stringField(value, key) ?? []);

const collectKnownPaths = <ArgsInput>(args: ArgsInput): ReadonlyArray<string> => {
  const input = asObject(args);
  if (!input) return [];
  const changes = Array.isArray(input.changes) ? input.changes : [];
  return [
    ...new Set([
      ...pathFields(input, PATH_KEYS),
      ...changes.slice(0, MAX_NATIVE_CHANGE_PATHS).flatMap((change) => {
        const item = asObject(change);
        return [
          ...pathFields(item, PATH_KEYS).slice(0, 1),
          ...pathFields(asObject(item?.kind), MOVE_PATH_KEYS).slice(0, 1),
        ];
      }),
      ...(changes.length > MAX_NATIVE_CHANGE_PATHS
        ? ["/<native-file-change-set-exceeded-observation-bound>"]
        : []),
    ]),
  ];
};

/** Returns the paths a native file-write tool names, or undefined for other tools. */
export const observeFileWrite = <ArgsInput>(
  toolName: string,
  args: ArgsInput,
): ReadonlyArray<string> | undefined =>
  FILE_WRITE_TOOL_NAMES.has(toolName.trim().toLocaleLowerCase("en-US"))
    ? collectKnownPaths(args)
    : undefined;

const bashMutationPatterns: ReadonlyArray<RegExp> = [
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|tee|install)\b/u,
  /(^|[^<])>{1,2}(?!>)/u,
  /\bsed\b[^\n;&|]*\s-i(?:\s|$)/u,
  /\bgit\s+(?:add|apply|checkout|clean|commit|merge|mv|rebase|reset|restore|rm|stash|switch)\b/u,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|update|upgrade)\b/u,
];

export const bashCommandMayMutate = <ArgsInput>(toolName: string, args: ArgsInput): boolean => {
  if (toolName.trim().toLocaleLowerCase("en-US") !== "bash") return false;
  const command = stringField(asObject(args), "command");
  return command !== undefined && bashMutationPatterns.some((pattern) => pattern.test(command));
};

/** Writers are unsupported on Windows, so canonical writer cwd paths are POSIX here. */
export const workspaceRelativeObservedPath = (
  canonicalCwd: string,
  observedPath: string,
): string | undefined => {
  const cwd = canonicalCwd.replace(/\/$/, "");
  const candidate = observedPath.trim().normalize("NFC");
  const relative = !candidate.startsWith("/")
    ? candidate
    : candidate.startsWith(`${cwd}/`)
      ? candidate.slice(cwd.length + 1)
      : undefined;
  if (relative === undefined) return undefined;
  const normalized = normalizeWriteClaim(relative);
  return normalized.ok ? normalized.claims[0] : undefined;
};
