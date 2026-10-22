import { getCurrentTools, type Api, type Model, type SystemMessage } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";

export const FORK_PROMPT_CACHE_KEY_ENV = "PI_SUBAGENT_PROMPT_CACHE_KEY";

// OpenAI accepts at most 64 characters; Pi truncates the parent's own key the same way.
const MAX_PROMPT_CACHE_KEY_CHARS = 64;

type RequestMessage = ContextWithSystemEvent["messages"][number];

/**
 * How a same-model fork keeps its requests on the parent's cached prefix.
 *
 * - `native`: the request-level tool list stays the parent's, and the transport withdraws and
 *   adds tools in place after the fork point (Anthropic inline tool changes).
 * - `additional-tools`: Pi declares every tool in place from the head of the input and announces
 *   removals as text, so the child's own tool changes follow the parent's prefix (OpenAI
 *   Responses additional tools).
 * - `tool-search`: tool search can only add tools in place, and a removal or redefinition rewrites
 *   the request-level tool list, so requests keep the parent's tool declarations and anchor the
 *   child's new tools in place.
 */
type ForkPromptCacheRoute = "native" | "additional-tools" | "tool-search";

/**
 * Codex is excluded: Pi derives its `session-id` header from the child's own session after
 * extension headers apply, and measured forks never reached the parent's cache without it.
 */
export const forkPromptCacheRoute = (
  model: Pick<Model<Api>, "api" | "compat">,
): ForkPromptCacheRoute | undefined => {
  const compat = model.compat;
  if (
    !compat ||
    !("supportsMidConvoSystemMessages" in compat) ||
    !compat.supportsMidConvoSystemMessages
  )
    return undefined;
  if (model.api === "anthropic-messages")
    return "supportsMidConvoToolChanges" in compat && compat.supportsMidConvoToolChanges
      ? "native"
      : undefined;
  if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") return undefined;
  if ("supportsAdditionalTools" in compat && compat.supportsAdditionalTools)
    return "additional-tools";
  return "supportsToolSearch" in compat && compat.supportsToolSearch ? "tool-search" : undefined;
};

export const forkPromptCacheKey = (parentSessionId: string): string =>
  Array.from(parentSessionId).slice(0, MAX_PROMPT_CACHE_KEY_CHARS).join("");

const isSystemMessage = (message: RequestMessage): message is SystemMessage =>
  message.role === "system";

const withoutInheritedTools = (
  message: SystemMessage,
  inherited: ReadonlySet<string>,
): SystemMessage => {
  const { toolsAdded, toolsRemoved, ...rest } = message;
  const added = toolsAdded?.filter((tool) => !inherited.has(tool.name)) ?? [];
  const removed = toolsRemoved?.filter((tool) => !inherited.has(tool.name)) ?? [];
  if (added.length === (toolsAdded?.length ?? 0) && removed.length === (toolsRemoved?.length ?? 0))
    return message;
  return {
    ...rest,
    ...(added.length > 0 && { toolsAdded: added }),
    ...(removed.length > 0 && { toolsRemoved: removed }),
  };
};

/**
 * Keep the parent's tool declarations in a forked child's request so its tool list matches the
 * parent's cached prefix. System messages written since the fork lose their removals and
 * redefinitions of inherited tools; tools new to the child stay as in-place additions. Only the
 * request changes: the child never registers the parent's other tools, so calling one fails as
 * an unknown tool. Requests that no longer start with the inherited prompt are left alone.
 */
const keepInheritedToolDeclarations = (
  messages: ReadonlyArray<RequestMessage>,
  forkedAt: number,
): Array<RequestMessage> | undefined => {
  const head = messages[0];
  if (!head || !isSystemMessage(head) || head.timestamp >= forkedAt) return undefined;
  const inherited = new Set(
    getCurrentTools(
      messages.filter(isSystemMessage).filter((message) => message.timestamp < forkedAt),
    ).map((tool) => tool.name),
  );
  let changed = false;
  const projected = messages.map((message) => {
    if (!isSystemMessage(message) || message.timestamp < forkedAt) return message;
    const kept = withoutInheritedTools(message, inherited);
    if (kept !== message) changed = true;
    return kept;
  });
  return changed ? projected : undefined;
};

// Only APIs that route caching by key carry one; the parent's key replaces the child's own.
const isKeyedPayload = Schema.is(Schema.Struct({ prompt_cache_key: Schema.String }));

/**
 * A fork that shares its parent's prompt cache starts from the parent's verbatim prompt state.
 * Its requests carry the parent's cache key and, on the `tool-search` route, the parent's tools.
 */
export const registerForkPromptCacheHooks = (
  pi: ExtensionAPI,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const key = environment[FORK_PROMPT_CACHE_KEY_ENV];
  if (!key) return;
  pi.on("context_with_system", (event, ctx) => {
    if (!ctx.model || forkPromptCacheRoute(ctx.model) !== "tool-search") return undefined;
    const header = invokeHostCallback(() => ctx.sessionManager.getHeader(), null);
    const forkedAt = header ? Date.parse(header.timestamp) : Number.NaN;
    if (!Number.isFinite(forkedAt)) return undefined;
    const messages = keepInheritedToolDeclarations(event.messages, forkedAt);
    return messages ? { messages } : undefined;
  });
  pi.on("before_provider_request", (event) =>
    isKeyedPayload(event.payload) && event.payload.prompt_cache_key !== key
      ? { ...event.payload, prompt_cache_key: key }
      : undefined,
  );
};
