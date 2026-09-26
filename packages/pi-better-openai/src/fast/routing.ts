import type { Api, Model } from "@earendil-works/pi-ai";
import { FAST_SERVICE_TIER } from "./models.ts";

export const CODEX_FAST_ROUTING_HEADER = "x-codex-routing-hint";

const CANONICAL_CODEX_PATHS = new Set([
  "/backend-api",
  "/backend-api/codex",
  "/backend-api/codex/responses",
]);

export function isCanonicalCodexEndpoint(baseUrl: string | undefined): boolean {
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

export function codexFastRoutingHint(
  model: Model<Api> | null | undefined,
  active: boolean,
): string | undefined {
  if (
    !active ||
    !model ||
    model.provider !== "openai-codex" ||
    model.api !== "openai-codex-responses" ||
    !isCanonicalCodexEndpoint(model.baseUrl)
  )
    return undefined;
  return `model=${model.id};tier=${FAST_SERVICE_TIER}`;
}
