/** Owned producer text. Keep these bytes stable in model-facing replies. */
export const MCP_VALIDATION_NOTICES = {
  failed: {
    invocation:
      "Completed MCP output failed its captured schema validation. The operation was not replayed.",
    normalization:
      "Completed output failed validation. Do not repeat the operation to recover its output.",
  },
  unavailable: {
    invocation:
      "Completed MCP output could not be schema-validated. This is not evidence of an output mismatch. The operation was not replayed.",
    normalization:
      "Local output validation was unavailable; no mismatch established. Do not repeat the operation to recover its output.",
  },
} as const;

export type McpValidationNoticeIdentity = keyof typeof MCP_VALIDATION_NOTICES;
