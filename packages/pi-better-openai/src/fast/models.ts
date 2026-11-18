import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

export type OpenAIFastMode = boolean | "ultrafast";
export const FAST_SERVICE_TIER = "priority";
export type FastServiceTier = typeof FAST_SERVICE_TIER | "ultrafast";

export function serviceTierForFastMode(
  provider: string | undefined,
  model: string | undefined,
  mode: OpenAIFastMode,
): FastServiceTier | undefined {
  if (!model) return undefined;
  if (mode === true && (provider === "openai" || provider === "openai-codex"))
    return FAST_SERVICE_TIER;
  return mode === "ultrafast" && provider === "openai-codex" && model === "gpt-6.2-sol"
    ? mode
    : undefined;
}

export function supportsFastModel(
  provider: string | undefined,
  model: string | undefined,
  mode: OpenAIFastMode = true,
): boolean {
  return serviceTierForFastMode(provider, model, mode) !== undefined;
}

/** The private launch contract shared by the child bridge and read-only child projections. */
export function childOpenAIFastMode(
  environment: Readonly<NodeJS.ProcessEnv>,
): OpenAIFastMode | undefined {
  if (environment.PI_SUBAGENT_CHILD !== "1") return undefined;
  const mode = environment.PI_SUBAGENT_OPENAI_FAST_MODE;
  return mode === "ultrafast" ? mode : mode === "priority";
}

export const fastModeMark = (mode: OpenAIFastMode | undefined): string =>
  mode === "ultrafast" ? "⚡⚡" : mode ? "⚡" : "";

const CANONICAL_CODEX_PATHS = new Set([
  "/backend-api",
  "/backend-api/codex",
  "/backend-api/codex/responses",
]);

function isCanonicalCodexEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const path = Fn.pipe(url.pathname, Str.replace(/\/+$/, ""));
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

export function applyCodexRoutingHint(
  headers: ProviderHeaders,
  model: Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl"> | undefined,
  tier: FastServiceTier | undefined,
): void {
  if (
    !tier ||
    model?.provider !== "openai-codex" ||
    model.api !== "openai-codex-responses" ||
    !isCanonicalCodexEndpoint(model.baseUrl) ||
    serviceTierForFastMode(model.provider, model.id, tier === "ultrafast" ? tier : true) !== tier
  )
    return;
  headers["x-codex-routing-hint"] = `model=${model.id};tier=${tier}`;
}
