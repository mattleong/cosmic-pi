// Keep Pi's jiti root alias from treating this deep export as a child of compat.js.
import { closeOpenAICodexWebSocketSessions } from "#pi-ai-openai-codex-responses";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeBestEffort } from "pi-cosmic-core";

export function resetOpenAICodexTransport(ctx: ExtensionContext): void {
  invokeBestEffort(() => closeOpenAICodexWebSocketSessions(ctx.sessionManager.getSessionId()));
}
