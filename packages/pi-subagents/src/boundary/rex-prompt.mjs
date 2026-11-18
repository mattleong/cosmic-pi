// @ts-check

/** The SDK host and the Pi-loaded extension may see different module instances. Only the session's event bus joins them. */
export const REX_PROMPT_EVENT = "pi-subagents:rex-prompt";

/**
 * @typedef {"started" | "queued" | "handled"} RexPromptDisposition
 * @typedef {(text: string, steer: boolean) => Promise<RexPromptDisposition>} RexPrompt
 * @typedef {{ sessionId: string, prompt: RexPrompt | undefined }} RexPromptQuery
 *
 * The host fills in query.prompt synchronously. That prompt is bound to that session and resolves on
 * SDK preflight, not at turn end. A rejection means preflight failed before admission.
 */
