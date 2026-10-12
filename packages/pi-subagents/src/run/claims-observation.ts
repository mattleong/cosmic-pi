import * as Arr from "effect/Array";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { normalizeWriteClaim } from "../domain/write-claims.ts";

export const MAX_OBSERVED_WRITE_PATHS = 64;
export const MAX_WRITE_CLAIM_VIOLATIONS = 16;
const MAX_NATIVE_CHANGE_PATHS = 256;

const FILE_WRITE_TOOL_NAMES = new Set(["edit", "write", "notebookedit", "applypatch"]);
const PATH_KEYS = ["path", "file_path", "filePath"] as const;
const MOVE_PATH_KEYS = ["move_path", "movePath"] as const;

const ToolArgumentsSchema = Schema.Record(Schema.String, Schema.Unknown);
export type ToolArguments = typeof ToolArgumentsSchema.Type;
const decodeToolArgumentsOption = Schema.decodeUnknownOption(ToolArgumentsSchema);

export const decodeToolArguments = flow(decodeToolArgumentsOption, Option.getOrUndefined);

export const stringField = (value: ToolArguments | undefined, key: string): string | undefined => {
  const field = value?.[key];
  return Predicate.isString(field) && field.trim() ? field.trim() : undefined;
};

const pathFields = (value: ToolArguments | undefined, keys: ReadonlyArray<string>) =>
  keys.flatMap((key) => stringField(value, key) ?? []);

const collectKnownPaths = (input: ToolArguments | undefined): ReadonlyArray<string> => {
  if (!input) return [];
  const changes = Arr.isArray(input.changes) ? input.changes : [];
  return [
    ...new Set([
      ...pathFields(input, PATH_KEYS),
      ...changes.slice(0, MAX_NATIVE_CHANGE_PATHS).flatMap((change) => {
        const item = decodeToolArguments(change);
        return pathFields(item, PATH_KEYS)
          .slice(0, 1)
          .concat(pathFields(decodeToolArguments(item?.kind), MOVE_PATH_KEYS).slice(0, 1));
      }),
      ...(changes.length > MAX_NATIVE_CHANGE_PATHS
        ? ["/<native-file-change-set-exceeded-observation-bound>"]
        : []),
    ]),
  ];
};

export const observeFileWrite = (
  toolName: string,
  args: ToolArguments | undefined,
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

export const bashCommandMayMutate = (
  toolName: string,
  args: ToolArguments | undefined,
): boolean => {
  if (toolName.trim().toLocaleLowerCase("en-US") !== "bash") return false;
  const command = stringField(args, "command");
  return command !== undefined && bashMutationPatterns.some((pattern) => pattern.test(command));
};

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
