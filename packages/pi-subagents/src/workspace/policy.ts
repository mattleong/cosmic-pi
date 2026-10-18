/** Most changed paths one partial apply may name. */
export const MAX_WORKSPACE_FILES = 4000;

const CREDENTIAL_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure|\.gnupg|\.kube|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/iu;
const CREDENTIAL_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;

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
  credentialWorkspacePath(path) && !SOURCE_CODE_EXTENSION.test(path);

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
