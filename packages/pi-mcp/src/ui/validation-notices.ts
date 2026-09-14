import { prefixBytes } from "../results/normalize.ts";
import {
  MCP_VALIDATION_NOTICES,
  type McpValidationNoticeIdentity,
} from "../results/validation-notices.ts";

const warnings = {
  failed:
    "The original operation completed but output validation failed against its captured schema. Do not replay the operation to recover its output.",
  unavailable:
    "The original operation completed but local output validation was unavailable. No mismatch was established. Do not replay the operation to recover its output.",
} as const;

/** Raw descriptor-read evidence only. Never inspect remote data.result or match sanitized prose. */
export const validationNoticeIdentity = (evidence: {
  readonly action: unknown;
  readonly outcome: unknown;
  readonly isError: unknown;
  readonly originAction: unknown;
  readonly originOutcome: unknown;
  readonly originIsError: unknown;
  readonly outputValidation: unknown;
}): McpValidationNoticeIdentity | undefined => {
  if (
    evidence.outcome !== "completed" ||
    evidence.originAction !== "tools.call" ||
    evidence.originOutcome !== "completed" ||
    evidence.originIsError !== false ||
    !(
      (evidence.action === "tools.call" && evidence.isError === true) ||
      (evidence.action === "result.read" && evidence.isError === false)
    )
  )
    return undefined;
  return evidence.outputValidation === "failed" || evidence.outputValidation === "unavailable"
    ? evidence.outputValidation
    : undefined;
};

export const canonicalValidationWarning = (identity: McpValidationNoticeIdentity): string =>
  warnings[identity];

export const isOwnedValidationNotice = <Value>(
  raw: Value,
  identity: McpValidationNoticeIdentity,
): boolean =>
  Object.values(MCP_VALIDATION_NOTICES[identity]).some(
    (text) => raw === text || raw === prefixBytes(text, 128),
  );
