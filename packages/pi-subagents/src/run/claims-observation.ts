import * as Arr from "effect/Array";
import { flow } from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  normalizeWriteClaim,
  OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
  TEMPORARY_DIRECTORY_WRITE_MARKER,
} from "../domain/write-claims.ts";

export const MAX_OBSERVED_WRITE_PATHS = 64;
export const MAX_WRITE_CLAIM_VIOLATIONS = 16;
const MAX_NATIVE_CHANGE_PATHS = 256;
/** Stands in for native change-set paths beyond the observation bound. */
const CHANGE_SET_OVERFLOW_PATH = "/<native-file-change-set-exceeded-observation-bound>";

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
      ...(changes.length > MAX_NATIVE_CHANGE_PATHS ? [CHANGE_SET_OVERFLOW_PATH] : []),
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

// Global options such as `-C dir`, `-c key=value`, and `--git-dir=path` may precede the subcommand.
const GIT_ARGUMENT = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const GIT_GLOBAL_OPTION = String.raw`(?:-[Cc]\s+${GIT_ARGUMENT}|--(?:git-dir|work-tree|namespace)\s+${GIT_ARGUMENT}|-{1,2}[A-Za-z][\w-]*(?:=${GIT_ARGUMENT})?)`;
const GIT_MUTATION = new RegExp(
  String.raw`\bgit(?:\s+${GIT_GLOBAL_OPTION})*\s+(?:add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|pull|rebase|reset|restore|revert|rm|stash|switch)\b`,
  "u",
);

const bashMutationPatterns: ReadonlyArray<RegExp> = [
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|tee|install)\b/u,
  /(^|[^<])>{1,2}(?!>)/u,
  /\bsed\b[^\n;&|]*\s-i(?:\s|$)/u,
  GIT_MUTATION,
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

const lexicalSegments = (cwd: string, path: string): ReadonlyArray<string> => {
  const segments: Array<string> = [];
  for (const segment of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
};

const lexicalAbsolutePath = (cwd: string, path: string): string =>
  `/${lexicalSegments(cwd, path).join("/")}`;

// macOS exposes /tmp and /var through /private symlinks; match both spellings lexically.
const privateAliases = (path: string): ReadonlyArray<string> =>
  /^\/private\/(?:tmp|var)(?:\/|$)/u.test(path)
    ? [path, path.slice("/private".length)]
    : /^\/(?:tmp|var)(?:\/|$)/u.test(path)
      ? [path, `/private${path}`]
      : [path];

const foldSegment = (segment: string): string => segment.toLocaleLowerCase("en-US");

/** The segments of `path` below `ancestor`, compared segment-wise and case-insensitively. */
const segmentsBelow = (
  path: ReadonlyArray<string>,
  ancestor: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined =>
  ancestor.length <= path.length &&
  ancestor.every((segment, index) => foldSegment(segment) === foldSegment(path[index] ?? ""))
    ? path.slice(ancestor.length)
    : undefined;

const isStrictlyUnder = (path: string, root: string): boolean => path.startsWith(`${root}/`);

/** System temporary roots for the host's temporary directory, as lexical absolute paths. */
export const systemTemporaryRoots = (tmpdir: string): ReadonlyArray<string> => [
  ...new Set(
    [tmpdir, "/tmp", "/var/tmp"].flatMap((candidate) => {
      const root = lexicalAbsolutePath("/", candidate);
      return candidate.startsWith("/") && root !== "/" ? privateAliases(root) : [];
    }),
  ),
];

/**
 * `outside` is a definite lexical path outside the workspace and its temporary roots.
 * `unresolved` covers observations that may touch the workspace without a checkable path: empty
 * observations, the change-set overflow sentinel, and in-workspace paths that aren't valid claims.
 */
export type ObservedWrite =
  | { readonly kind: "workspace"; readonly path: string }
  | { readonly kind: "temporary" }
  | { readonly kind: "outside" }
  | { readonly kind: "unresolved" };

export const UNRESOLVED_OBSERVED_WRITE: ObservedWrite = { kind: "unresolved" };

/** The write-audit spelling; outside and unresolved writes share the outside-workspace marker. */
export const observedWriteAuditPath = (write: ObservedWrite): string =>
  Match.value(write).pipe(
    Match.when({ kind: "workspace" }, ({ path }) => path),
    Match.when({ kind: "temporary" }, () => TEMPORARY_DIRECTORY_WRITE_MARKER),
    Match.orElse(() => OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER),
  );

/**
 * Classifies one observed native write after lexical resolution against the cwd. Workspace
 * containment wins under any cwd spelling, so a cwd inside a temporary root still enforces
 * claims. A temporary root equal to or above the cwd, such as TMPDIR=$HOME or `/`, is ignored.
 */
export const classifyObservedWrite = (
  canonicalCwd: string,
  observedPath: string,
  temporaryRoots: ReadonlyArray<string>,
): ObservedWrite => {
  const candidate = observedPath.trim().normalize("NFC");
  if (!candidate || candidate === CHANGE_SET_OVERFLOW_PATH) return UNRESOLVED_OBSERVED_WRITE;
  const cwd = lexicalAbsolutePath("/", canonicalCwd);
  const resolved = lexicalSegments(cwd, candidate);
  const cwdAliases = privateAliases(cwd).map((alias) => lexicalSegments("/", alias));
  for (const alias of cwdAliases) {
    const relative = segmentsBelow(resolved, alias);
    if (relative === undefined) continue;
    const normalized = normalizeWriteClaim(relative.join("/"));
    const path = normalized.ok ? normalized.claims[0] : undefined;
    return path === undefined ? UNRESOLVED_OBSERVED_WRITE : { kind: "workspace", path };
  }
  const absolute = `/${resolved.join("/")}`;
  const temporary = temporaryRoots.some((root) => {
    const rootSegments = lexicalSegments("/", root);
    return (
      isStrictlyUnder(absolute, `/${rootSegments.join("/")}`) &&
      !cwdAliases.some((alias) => segmentsBelow(alias, rootSegments) !== undefined)
    );
  });
  return { kind: temporary ? "temporary" : "outside" };
};
