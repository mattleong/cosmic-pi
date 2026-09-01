import type { ProviderHeaders } from "@earendil-works/pi-ai";
// Keep Pi's jiti root alias from treating this deep export as a child of compat.js.
import { closeOpenAICodexWebSocketSessions } from "#pi-ai-openai-codex-responses";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFastActive, type FastSnapshot } from "../fast/controller.ts";
import { CODEX_FAST_ROUTING_HEADER, codexFastRoutingHint } from "../fast/routing.ts";

export function applyFastRoutingHeaders(
  headers: ProviderHeaders,
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
  serviceTier: string,
): void {
  const hint = codexFastRoutingHint(ctx.model, isFastActive(ctx, snapshot), serviceTier);
  if (hint) headers[CODEX_FAST_ROUTING_HEADER] = hint;
}

export function resetOpenAICodexTransport(ctx: ExtensionContext): void {
  try {
    closeOpenAICodexWebSocketSessions(ctx.sessionManager.getSessionId());
  } catch {
    // Provider transport cleanup is best effort at this Pi host boundary.
  }
}
