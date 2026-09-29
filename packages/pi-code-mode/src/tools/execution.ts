import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { invokeHostCallback } from "pi-cosmic-core";
import type { CodeModeResult } from "../engine/diagnostic.ts";
import type { ExecuteProgramOptions } from "../engine/execute.ts";
import { type NestedPiToolDefinitions } from "../boundary/host-builtin-tools.ts";
import type { CodeModeState } from "../config/store.ts";
import { resultReadFailure } from "../results/read-presentation.ts";
import type { ResultsContract } from "../results/service.ts";
import { callEntryDetails, type CodeModeToolDetails } from "./format.ts";
import { clampModelVisibleText } from "./limits.ts";
import {
  isExecutionInput,
  isStatusInput,
  readRetainedResult,
  type CodeModeInput,
} from "./result-read.ts";
import { codeModeStatusResult } from "./status.ts";

import { cancelledResult, runCodeModeExecution } from "./execution-run.ts";
/**
 * Refusal for the stale/no-state gate, where no current configuration (and therefore no
 * `maxOutputBytes`) exists to clamp against: a short, fixed, bounded constant is the only
 * model-visible text this path can produce. Every other model-visible result or thrown
 * message - including the refusal for a current-but-unavailable session - goes through
 * `clampModelVisibleText` with the current session's `maxOutputBytes`.
 */
export const CODE_MODE_UNAVAILABLE_MESSAGE =
  "code_mode is not available in this session (it requires a trusted project, Code Mode " +
  "enabled, and a current session runtime). Start a new session or run /reload after " +
  "trusting the project or enabling Code Mode.";

export interface CodeModeExecutionEnvironment {
  readonly results?: ResultsContract;
  /** True only while this registration's session slot generation is still current. */
  readonly isCurrent: () => boolean;
  /** Live resolved configuration snapshot for the current session. */
  readonly getState: () => CodeModeState | undefined;
  /** Runs one effect on the current session runtime; the signal interrupts the fiber. */
  readonly runInSession: <A>(effect: Effect.Effect<A>, signal?: AbortSignal) => Promise<A>;
  /** Session directory captured at activation; nested built-ins and programs run there. */
  readonly cwd: string;
  /** Pi built-in definitions captured for this registration's cwd and platform. */
  readonly definitions: NestedPiToolDefinitions;
  /** Shared event bus used only for the explicit Background Tasks and MCP protocols. */
  readonly events: ExtensionAPI["events"];
  /** Stable Pi session id captured at activation; absence makes the adapter fail closed. */
  readonly sessionId: string | undefined;
  /** Program execution boundary; injectable for tests. */
  readonly executeCodeMode?: (
    options: ExecuteProgramOptions<never>,
  ) => Effect.Effect<CodeModeResult>;
  /** One-shot handoff to the `tool_result` hook for failures Pi converts to details `{}`. */
  readonly retainFailureDetails?: (toolCallId: string, details: CodeModeToolDetails) => void;
}

export type CodeModeToolExecute = (
  toolCallId: string,
  params: CodeModeInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CodeModeToolDetails> | undefined,
  ctx: ExtensionToolContext,
) => Promise<AgentToolResult<CodeModeToolDetails>>;

/** Admission gate: the current session slot and an available state, read in that order. */
const liveState = (environment: CodeModeExecutionEnvironment): CodeModeState => {
  const state = environment.getState();
  if (!environment.isCurrent() || state === undefined) {
    throw new Error(CODE_MODE_UNAVAILABLE_MESSAGE);
  }
  if (!state.available) {
    throw new Error(
      clampModelVisibleText(CODE_MODE_UNAVAILABLE_MESSAGE, state.config.maxOutputBytes),
    );
  }
  return state;
};

export const makeCodeModeToolExecute =
  (environment: CodeModeExecutionEnvironment): CodeModeToolExecute =>
  (toolCallId, params, signal, onUpdate, ctx) =>
    // Synchronous refusals become rejections here, exactly as the prior async form produced.
    Promise.resolve().then(() => {
      const { config } = liveState(environment);
      if (invokeHostCallback(() => signal?.aborted === true, true)) {
        return cancelledResult(callEntryDetails([]), config.maxOutputBytes);
      }
      if (isStatusInput(params)) {
        // Status is a live projection, not the registration-time description snapshot. Reread
        // after the current, availability, and cancellation gates so settings committed during
        // admission are reflected without entering the session runner or configuration store.
        return codeModeStatusResult(liveState(environment).config);
      }
      if (params.action === "result.read") {
        return environment
          .runInSession(
            readRetainedResult(params, environment.results, config.maxOutputBytes),
            signal,
          )
          .then((read) => {
            if (invokeHostCallback(() => signal?.aborted === true, true))
              return cancelledResult(callEntryDetails([]), config.maxOutputBytes);
            const current =
              environment.isCurrent() && environment.getState()?.available === true
                ? read
                : resultReadFailure("revoked", config.maxOutputBytes);
            return {
              content: [{ type: "text" as const, text: current.text }],
              details: { toolCalls: [], resultRead: current.presentation },
            };
          });
      }
      if (!isExecutionInput(params)) {
        throw new Error(
          clampModelVisibleText(
            "Invalid Code Mode request. Use code with optional intent, status alone, or result.read with id and no code or intent. No execution was run.",
            config.maxOutputBytes,
          ),
        );
      }
      return runCodeModeExecution(environment, config, toolCallId, params, signal, onUpdate, ctx);
    });
