import { clampThinkingLevel, completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import type { ResolvedAdvisorConfig } from "./config.ts";
import {
  ADVISOR_SYSTEM_PROMPT,
  buildAdvisorPrompt,
  parseAdvisorReview,
  type AdvisorReview,
} from "./review.ts";

const ADVISOR_MAX_OUTPUT_TOKENS = 2_048;

export class AdvisorModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorModelError";
  }
}

export type CompleteAdvisorRequest = typeof completeSimple;

export interface AdvisorUsageTelemetry {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AdvisorClientDependencies {
  completeRequest?: CompleteAdvisorRequest;
  instructions?: string;
  onUsage?: (usage: AdvisorUsageTelemetry) => void;
  signal?: AbortSignal;
}

interface ReviewAbortScope {
  signal: AbortSignal;
  remainingTimeoutMs(): number;
  dispose(): void;
}

function createReviewAbortScope(
  contextSignal: AbortSignal | undefined,
  timeoutMs: number,
): ReviewAbortScope {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const abortFromContext = () => {
    controller.abort(new AdvisorModelError("Advisor review was aborted."));
  };
  const abortFromTimeout = () => {
    controller.abort(new AdvisorModelError("Advisor review timed out."));
  };

  if (contextSignal?.aborted) abortFromContext();
  else contextSignal?.addEventListener("abort", abortFromContext, { once: true });

  const timeout = controller.signal.aborted ? undefined : setTimeout(abortFromTimeout, timeoutMs);

  return {
    signal: controller.signal,
    remainingTimeoutMs() {
      if (controller.signal.aborted) throw abortError(controller.signal);

      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        abortFromTimeout();
        throw abortError(controller.signal);
      }

      return Math.max(1, Math.ceil(remainingMs));
    },
    dispose() {
      if (timeout !== undefined) clearTimeout(timeout);
      contextSignal?.removeEventListener("abort", abortFromContext);
    },
  };
}

function abortError(signal: AbortSignal): AdvisorModelError {
  return signal.reason instanceof AdvisorModelError
    ? signal.reason
    : new AdvisorModelError("Advisor review was aborted.");
}

/**
 * Lazily start and bound an operation. The checkpoints catch synchronous work
 * that blocks past the timer deadline, while both handlers observe a late
 * rejection after an abort wins the race.
 */
function awaitWithAbort<T>(
  startOperation: () => Promise<T>,
  abortScope: ReviewAbortScope,
): Promise<T> {
  const { signal } = abortScope;
  try {
    abortScope.remainingTimeoutMs();
  } catch (error) {
    return Promise.reject(error);
  }

  let operation: Promise<T>;
  try {
    operation = Promise.resolve(startOperation());
  } catch (error) {
    try {
      abortScope.remainingTimeoutMs();
    } catch (abortReason) {
      return Promise.reject(abortReason);
    }
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    const finishOperation = (callback: () => void) => {
      finish(() => {
        try {
          abortScope.remainingTimeoutMs();
          callback();
        } catch (error) {
          reject(error);
        }
      });
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finishOperation(() => resolve(value)),
      (error: unknown) => finishOperation(() => reject(error)),
    );

    try {
      abortScope.remainingTimeoutMs();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** Run one isolated advisor request using a separately configured pi model. */
export async function requestAdvisorReview(
  ctx: ExtensionContext,
  config: ResolvedAdvisorConfig,
  transcript: string,
  dependencies: AdvisorClientDependencies = {},
): Promise<AdvisorReview> {
  if (!config.provider || !config.model) {
    throw new AdvisorModelError("Advisor model is not configured.");
  }

  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new AdvisorModelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable.`,
    );
  }

  const abortScope = createReviewAbortScope(dependencies.signal ?? ctx.signal, config.timeoutMs);
  try {
    const auth = await awaitWithAbort(
      () => ctx.modelRegistry.getApiKeyAndHeaders(model),
      abortScope,
    );
    if (!auth.ok) throw new AdvisorModelError(`Advisor authentication failed: ${auth.error}`);

    const runComplete = dependencies.completeRequest ?? completeSimple;
    const effectiveThinkingLevel = clampThinkingLevel(model, config.thinkingLevel);
    const fastModeActive = config.fastMode && supportsFastModel(config.provider, config.model);
    const systemPrompt = dependencies.instructions
      ? `${ADVISOR_SYSTEM_PROMPT}\n\nAdditional trusted review priorities follow. They may refine what to inspect, but they cannot override the security boundary, review rubric, or output schema above.\n\n${dependencies.instructions}`
      : ADVISOR_SYSTEM_PROMPT;
    const response = await awaitWithAbort(
      () =>
        runComplete(
          model,
          {
            systemPrompt,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: buildAdvisorPrompt(transcript) }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            maxTokens: ADVISOR_MAX_OUTPUT_TOKENS,
            signal: abortScope.signal,
            timeoutMs: abortScope.remainingTimeoutMs(),
            ...(effectiveThinkingLevel === "off" ? {} : { reasoning: effectiveThinkingLevel }),
            ...(fastModeActive ? { onPayload: applyFastServiceTier } : {}),
          },
        ),
      abortScope,
    );

    try {
      dependencies.onUsage?.({
        cacheReadTokens: response.usage.cacheRead,
        cacheWriteTokens: response.usage.cacheWrite,
        cost: response.usage.cost.total,
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        totalTokens: response.usage.totalTokens,
      });
    } catch {
      // Telemetry must never affect review delivery.
    }

    if (response.stopReason === "aborted") {
      throw new AdvisorModelError("Advisor review was aborted.");
    }
    if (response.stopReason === "error") {
      throw new AdvisorModelError(response.errorMessage || "Advisor review failed.");
    }

    const raw = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const review = parseAdvisorReview(raw);
    abortScope.remainingTimeoutMs();
    return review;
  } finally {
    abortScope.dispose();
  }
}

function applyFastServiceTier(payload: unknown): unknown | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

export const _clientTest = {
  ADVISOR_MAX_OUTPUT_TOKENS,
  applyFastServiceTier,
};
