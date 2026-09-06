// Conservative input policy, not a credential detector or an OS sandbox.
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

export const excludedWorkspacePath = (path: string): boolean =>
  path
    .split("/")
    .some(
      (part) =>
        /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.pi|node_modules|vendor|dist|build|coverage|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/iu.test(
          part,
        ) || /\.(?:pem|key|p12|pfx|jks|keystore)$/iu.test(part),
    );

export const eligibleUntrackedSource = (path: string): boolean =>
  safeWorkspacePath(path) &&
  !excludedWorkspacePath(path) &&
  (/\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml|toml|py|rs|go|c|h|cpp|hpp|java|kt|swift|rb|php|sh|bash|zsh|css|scss|html|vue|svelte|sql|graphql|proto|xml)$/iu.test(
    path,
  ) ||
    /(?:^|\/)(?:Dockerfile|Makefile|LICENSE|\.gitignore|\.editorconfig)$/u.test(path));

export const sensitiveWorkspaceContent = (bytes: Uint8Array): boolean => {
  const text = new TextDecoder().decode(bytes);
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/iu.test(
    text,
  );
};
