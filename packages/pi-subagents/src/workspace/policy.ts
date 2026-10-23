import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
const CREDENTIAL_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure|\.gnupg|\.kube|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/iu;
const CREDENTIAL_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;

/** Credential-shaped names; they exclude only files Git does not track. */
export const credentialWorkspacePath = (path: string): boolean =>
  Fn.pipe(
    path,
    Str.split("/"),
    Arr.some((part) => CREDENTIAL_NAME.test(part) || CREDENTIAL_EXTENSION.test(part)),
  );

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
