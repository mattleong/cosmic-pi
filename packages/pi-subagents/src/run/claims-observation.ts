import { hasObjectRuntimeType, type JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { normalizeWriteClaim } from "../domain/write-claims.ts";

export const MAX_OBSERVED_WRITE_PATHS = 64;
export const MAX_WRITE_CLAIM_VIOLATIONS = 16;
const MAX_NATIVE_CHANGE_PATHS = 256;

const FILE_WRITE_TOOL_NAMES = new Set(["edit", "write", "notebookedit", "applypatch"]);

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

const collectKnownPaths = <ArgsInput>(args: ArgsInput): ReadonlyArray<string> => {
  const input = asObject(args);
  if (!input) return [];
  const direct = [
    stringField(input, "path"),
    stringField(input, "file_path"),
    stringField(input, "filePath"),
  ].filter((value): value is string => value !== undefined);
  const changes = input.changes;
  if (!Array.isArray(changes)) return [...new Set(direct)];
  const overflowPath =
    changes.length > MAX_NATIVE_CHANGE_PATHS
      ? ["/<native-file-change-set-exceeded-observation-bound>"]
      : [];
  return [
    ...new Set([
      ...direct,
      ...changes.slice(0, MAX_NATIVE_CHANGE_PATHS).flatMap((change) => {
        const item = asObject(change);
        const path =
          stringField(item, "path") ??
          stringField(item, "file_path") ??
          stringField(item, "filePath");
        const kind = asObject(item?.kind);
        const movePath = stringField(kind, "move_path") ?? stringField(kind, "movePath");
        return [path, movePath].filter((value): value is string => value !== undefined);
      }),
      ...overflowPath,
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
  const cwd =
    canonicalCwd === "/"
      ? ""
      : canonicalCwd.endsWith("/")
        ? canonicalCwd.slice(0, -1)
        : canonicalCwd;
  const candidate = observedPath.trim().normalize("NFC");
  const relative = candidate.startsWith("/")
    ? cwd === ""
      ? candidate.slice(1)
      : candidate.startsWith(`${cwd}/`)
        ? candidate.slice(cwd.length + 1)
        : undefined
    : candidate;
  if (relative === undefined) return undefined;
  const normalized = normalizeWriteClaim(relative);
  return normalized.ok ? normalized.claims[0] : undefined;
};
