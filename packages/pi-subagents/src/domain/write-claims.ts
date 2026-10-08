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

const invalid = (code: string, message: string): WriteClaimNormalizationResult => ({
  ok: false,
  code,
  message,
});

export const normalizeWriteClaim = (input: string): WriteClaimNormalizationResult => {
  const value = input.trim().normalize("NFC");
  if (!value) return invalid("write_claim_required", "Write claims must be nonblank.");
  if (value.length > MAX_WRITE_CLAIM_CHARS)
    return invalid(
      "write_claim_too_large",
      `Write claims may contain at most ${MAX_WRITE_CLAIM_CHARS} characters.`,
    );
  if (/\p{Cc}/u.test(value))
    return invalid("write_claim_invalid", "Write claims may not contain control characters.");
  if (value.includes("\\"))
    return invalid(
      "write_claim_invalid",
      `Write claim "${value}" must use workspace-relative POSIX separators.`,
    );
  if (value.startsWith("/") || windowsAbsolutePath.test(value))
    return invalid(
      "write_claim_absolute",
      `Write claim "${value}" must be relative to the workspace.`,
    );
  if (claimKey(value) === outsideWorkspaceMarkerKey)
    return invalid(
      "write_claim_outside_workspace",
      "The outside-workspace audit marker cannot become a file claim.",
    );
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    return invalid(
      "write_claim_invalid",
      `Write claim "${value}" must be a normalized file path without empty, dot, or parent segments.`,
    );
  return { ok: true, claims: [value] };
};

export const normalizeWriteClaims = (
  inputs: ReadonlyArray<string> | undefined,
): WriteClaimNormalizationResult => {
  if (inputs === undefined) return { ok: true, claims: [] };
  if (inputs.length === 0)
    return invalid(
      "write_claims_required",
      "When writes is present it must contain at least one exact file path.",
    );
  if (inputs.length > MAX_WRITE_CLAIMS)
    return invalid(
      "too_many_write_claims",
      `A writer may claim at most ${MAX_WRITE_CLAIMS} files.`,
    );
  // Keyed case-insensitively, keeping each path's first spelling in input order.
  const claims = new Map<string, string>();
  for (const input of inputs) {
    const normalized = normalizeWriteClaim(input);
    if (!normalized.ok) return normalized;
    for (const claim of normalized.claims)
      if (!claims.has(claimKey(claim))) claims.set(claimKey(claim), claim);
  }
  return { ok: true, claims: [...claims.values()] };
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
