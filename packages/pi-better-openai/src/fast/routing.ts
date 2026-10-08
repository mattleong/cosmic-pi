import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFastActive, type FastSnapshot } from "./controller.ts";
import { FAST_SERVICE_TIER } from "./models.ts";

const CANONICAL_CODEX_PATHS = new Set([
  "/backend-api",
  "/backend-api/codex",
  "/backend-api/codex/responses",
]);

function isCanonicalCodexEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      CANONICAL_CODEX_PATHS.has(path)
    );
  } catch {
    return false;
  }
}

/** Adds Codex's priority routing hint to an active fast request for the canonical endpoint. */
export function applyFastRoutingHeaders(
  headers: ProviderHeaders,
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
): void {
  const model = ctx.model;
  if (
    !model ||
    model.provider !== "openai-codex" ||
    model.api !== "openai-codex-responses" ||
    !isCanonicalCodexEndpoint(model.baseUrl) ||
    !isFastActive(ctx, snapshot)
  )
    return;
  headers["x-codex-routing-hint"] = `model=${model.id};tier=${FAST_SERVICE_TIER}`;
}
