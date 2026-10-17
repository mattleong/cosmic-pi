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

export const eligibleUntrackedSource = (path: string): boolean =>
  safeWorkspacePath(path) &&
  !dependencyWorkspacePath(path) &&
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

/** Finds the first literal that looks like a credential, without returning the literal itself. */
export const sensitiveWorkspaceContent = (bytes: Uint8Array): SensitiveContentMatch | undefined => {
  const text = new TextDecoder().decode(bytes);
  let first: { readonly index: number; readonly rule: string } | undefined;
  for (const [pattern, rule] of SENSITIVE_CONTENT) {
    const index = pattern.exec(text)?.index;
    if (index !== undefined && (first === undefined || index < first.index))
      first = { index, rule };
  }
  return first && { rule: first.rule, line: text.slice(0, first.index).split("\n").length };
};
