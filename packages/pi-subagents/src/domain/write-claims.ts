export const MAX_WRITE_CLAIMS = 64;
export const MAX_WRITE_CLAIM_CHARS = 512;
export const OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER = "<outside workspace>";

export interface WriteClaimConflict {
  readonly left: string;
  readonly right: string;
}

export type WriteClaimNormalizationResult =
  | { readonly ok: true; readonly claims: ReadonlyArray<string> }
  | { readonly ok: false; readonly code: string; readonly message: string };

const windowsAbsolutePath = /^[a-zA-Z]:\//;

const claimKey = (claim: string): string => claim.normalize("NFC").toLocaleLowerCase("en-US");
const outsideWorkspaceMarkerKey = claimKey(OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER);

export const normalizeWriteClaim = (input: string): WriteClaimNormalizationResult => {
  const value = input.trim().normalize("NFC");
  if (!value)
    return { ok: false, code: "write_claim_required", message: "Write claims must be nonblank." };
  if (value.length > MAX_WRITE_CLAIM_CHARS)
    return {
      ok: false,
      code: "write_claim_too_large",
      message: `Write claims may contain at most ${MAX_WRITE_CLAIM_CHARS} characters.`,
    };
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return {
      ok: false,
      code: "write_claim_invalid",
      message: "Write claims may not contain control characters.",
    };
  if (value.includes("\\"))
    return {
      ok: false,
      code: "write_claim_invalid",
      message: `Write claim "${value}" must use workspace-relative POSIX separators.`,
    };
  if (value.startsWith("/") || value.startsWith("//") || windowsAbsolutePath.test(value))
    return {
      ok: false,
      code: "write_claim_absolute",
      message: `Write claim "${value}" must be relative to the workspace.`,
    };
  if (claimKey(value) === outsideWorkspaceMarkerKey)
    return {
      ok: false,
      code: "write_claim_outside_workspace",
      message: "The outside-workspace audit marker cannot become a file claim.",
    };
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return {
      ok: false,
      code: "write_claim_invalid",
      message: `Write claim "${value}" must be a normalized file path without empty, dot, or parent segments.`,
    };
  return { ok: true, claims: [segments.join("/")] };
};

export const normalizeWriteClaims = (
  inputs: ReadonlyArray<string> | undefined,
): WriteClaimNormalizationResult => {
  if (inputs === undefined) return { ok: true, claims: [] };
  if (inputs.length === 0)
    return {
      ok: false,
      code: "write_claims_required",
      message: "When writes is present it must contain at least one exact file path.",
    };
  if (inputs.length > MAX_WRITE_CLAIMS)
    return {
      ok: false,
      code: "too_many_write_claims",
      message: `A writer may claim at most ${MAX_WRITE_CLAIMS} files.`,
    };
  const claims: string[] = [];
  const keys = new Set<string>();
  for (const input of inputs) {
    const normalized = normalizeWriteClaim(input);
    if (!normalized.ok) return normalized;
    const claim = normalized.claims[0];
    if (!claim) continue;
    const key = claimKey(claim);
    if (keys.has(key)) continue;
    keys.add(key);
    claims.push(claim);
  }
  return { ok: true, claims };
};

export const firstWriteClaimConflict = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): WriteClaimConflict | undefined => {
  if (left === undefined || right === undefined)
    return { left: left?.[0] ?? "<exclusive>", right: right?.[0] ?? "<exclusive>" };
  const rightByKey = new Map(right.map((claim) => [claimKey(claim), claim]));
  for (const claim of left) {
    const conflicting = rightByKey.get(claimKey(claim));
    if (conflicting) return { left: claim, right: conflicting };
  }
  return undefined;
};

export const writeClaimContains = (
  claims: ReadonlyArray<string>,
  workspaceRelativePath: string,
): boolean => {
  const normalized = normalizeWriteClaim(workspaceRelativePath);
  const path = normalized.ok ? normalized.claims[0] : undefined;
  return path !== undefined && claims.some((claim) => claimKey(claim) === claimKey(path));
};
