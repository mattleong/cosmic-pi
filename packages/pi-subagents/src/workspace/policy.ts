export const MAX_WORKSPACE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
export const MAX_WORKSPACE_FILES = 4000;
export const safeWorkspacePath = (path: string): boolean =>
  path.length > 0 &&
  path.length < 1024 &&
  !/[\\:\p{Cc}]/u.test(path) &&
  path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !/^\.git$/iu.test(part)) &&
  !path.startsWith("-");

const DEPENDENCY_DIRECTORY = /^(?:node_modules|vendor|dist|build|coverage|\.pi)$/iu;
const CREDENTIAL_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure|\.gnupg|\.kube|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/iu;
const CREDENTIAL_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;

/**
 * Dependency, build, and Pi state directories never enter a snapshot, tracked or not. Only
 * directory names match, so a file such as `scripts/build` is source; set `mayBeDirectory` for
 * an entry, such as a symlink, that can itself stand in for a directory.
 */
export const dependencyWorkspacePath = (path: string, mayBeDirectory = false): boolean => {
  const parts = path.split("/");
  return (mayBeDirectory ? parts : parts.slice(0, -1)).some((part) =>
    DEPENDENCY_DIRECTORY.test(part),
  );
};

/** Credential-shaped names; they exclude only files Git does not track. */
export const credentialWorkspacePath = (path: string): boolean =>
  path.split("/").some((part) => CREDENTIAL_NAME.test(part) || CREDENTIAL_EXTENSION.test(part));

// Programming-language sources, which credential-shaped names such as `credentials.ts` can be.
// Data formats such as JSON, YAML, and text are not, because credential files use them.
const SOURCE_CODE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|rs|go|c|h|cc|cpp|hpp|cs|java|kt|kts|scala|swift|rb|php|ex|exs|lua|dart|sh|bash|zsh|vue|svelte)$/iu;

/**
 * An untracked private-tree file with a credential-shaped name that isn't source code, such as
 * `.env`, `.npmrc`, a `.pem` key, an SSH key, or `credentials.json`. Captures leave it out so a
 * worker's local secrets never reach a proposal; `src/auth/credentials.ts` stays source.
 */
export const credentialPrivatePath = (path: string): boolean =>
  safeWorkspacePath(path) && credentialWorkspacePath(path) && !SOURCE_CODE_EXTENSION.test(path);

/** Why captures leave an uncaptured worker file out on purpose; undefined when it blocks. */
export const leftOutReason = (path: string): "dependency" | "credential" | undefined =>
  dependencyWorkspacePath(path)
    ? "dependency"
    : credentialPrivatePath(path)
      ? "credential"
      : undefined;

/**
 * A worker file no capture can hold that blocks preparation and integration. Files in dependency,
 * build, and Pi state directories and credential files are left out on purpose, so they never
 * block.
 */
export const blockingUncapturedPath = (path: string): boolean => leftOutReason(path) === undefined;

/** The uncaptured worker files a revision leaves out on purpose. */
export const leftOutUncapturedPaths = (paths: ReadonlyArray<string> = []) =>
  paths.filter((path) => !blockingUncapturedPath(path));

/**
 * Untracked files a private tree (worker, prepared, or nested source) contributes: everything a
 * snapshot can represent outside dependency, build, and Pi state directories, except credential
 * files.
 */
export const capturablePrivatePath = (path: string): boolean =>
  safeWorkspacePath(path) && leftOutReason(path) === undefined;

/** Untracked files the user's checkout contributes: source-like names that aren't credentials. */
export const eligibleUntrackedSource = (path: string): boolean =>
  capturablePrivatePath(path) &&
  !credentialWorkspacePath(path) &&
  (/\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml|toml|py|rs|go|c|h|cpp|hpp|java|kt|swift|rb|php|sh|bash|zsh|css|scss|html|vue|svelte|sql|graphql|proto|xml)$/iu.test(
    path,
  ) ||
    /(?:^|\/)(?:Dockerfile|Makefile|LICENSE|\.gitignore|\.editorconfig)$/u.test(path));

const SENSITIVE_CONTENT: ReadonlyArray<readonly [pattern: RegExp, rule: string]> = [
  [/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/iu, "a private key block"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu, "an AWS access key ID"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/iu, "a GitHub token"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/iu, "an sk- API key"],
];

export interface SensitiveContentMatch {
  readonly rule: string;
  readonly line: number;
}

/**
 * Finds the first line that looks like it holds a credential, without returning the literal
 * itself. With `previous` content, only lines it doesn't already hold are scanned: lines compare
 * as a multiset, so unchanged or moved lines pass and each extra copy of a line counts as added.
 */
export const sensitiveWorkspaceContent = (
  bytes: Uint8Array,
  previous?: string,
): SensitiveContentMatch | undefined => {
  const held = new Map<string, number>();
  for (const line of previous?.split("\n") ?? []) held.set(line, (held.get(line) ?? 0) + 1);
  for (const [index, line] of new TextDecoder().decode(bytes).split("\n").entries()) {
    const copies = held.get(line) ?? 0;
    if (copies > 0) {
      held.set(line, copies - 1);
      continue;
    }
    const match = SENSITIVE_CONTENT.find(([pattern]) => pattern.test(line));
    if (match) return { rule: match[1], line: index + 1 };
  }
  return undefined;
};

const EXPORT_BRANCH_PREFIX = "pi-subagent/";
const MAX_BRANCH_SLUG_CHARS = 64;

/**
 * `pi-subagent/<slug>` from the writer's display name, falling back to the workspace ID when the
 * name leaves nothing a branch name can hold.
 */
export const exportBranchName = (name: string | undefined, workspaceId: string) => {
  const slug = (name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/[._-]{2,}/gu, "-")
    .slice(0, MAX_BRANCH_SLUG_CHARS)
    .replace(/^[._-]+|[._-]+$/gu, "")
    .replace(/\.lock$/u, "-lock");
  return `${EXPORT_BRANCH_PREFIX}${slug || workspaceId}`;
};

/**
 * A partial apply's selection from a revision's changed paths: the names it doesn't change, and
 * the selected paths in revision order, undefined when the selection names every changed path.
 */
export const partialSelection = (
  changedPaths: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
) => {
  const selected = new Set(paths);
  return {
    unknown: [...selected].filter((name) => !changedPaths.includes(name)),
    subset:
      selected.size === changedPaths.length
        ? undefined
        : changedPaths.filter((name) => selected.has(name)),
  };
};
