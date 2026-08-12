/**
 * One `code_mode` execution: defensive session gating, host limits, guest catalog assembly,
 * runtime execution with composed cancellation, bounded progress, and model-safe results.
 */
// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { CodeMode } from "../boundary/codemode-runtime.ts";
import {
  makeNestedPiToolDispatch,
  type NestedPiToolDefinitions,
} from "../boundary/host-builtin-tools.ts";
import { makeGuardedToolUpdatePublisher } from "../boundary/host-tool-update.ts";
import type { CodeModeState } from "../config/store.ts";
import { describeNestedActivity } from "../ui/tool-renderer.ts";
import { makeExecutionGuestTools } from "./catalog.ts";
import {
  callEntryDetails,
  formatCodeModeFailure,
  formatCodeModeSuccess,
  progressResult,
  type CodeModeCallEntry,
  type CodeModeToolDetails,
} from "./format.ts";
import { checkSourceSize, clampModelVisibleText, makeCumulativeOutputBudget } from "./limits.ts";

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
  /** True only while this registration's session slot generation is still current. */
  readonly isCurrent: () => boolean;
  /** Live resolved configuration snapshot for the current session. */
  readonly getState: () => CodeModeState | undefined;
  /** Runs one effect on the current session runtime; the signal interrupts the fiber. */
  readonly runInSession: <A>(effect: Effect.Effect<A>, signal?: AbortSignal) => Promise<A>;
  /** Built-in read/grep/find/ls definitions captured for this registration's cwd. */
  readonly definitions: NestedPiToolDefinitions;
}

interface MutableCallEntry {
  tool: string;
  status: CodeModeCallEntry["status"];
  /** Bounded human-readable label derived from the decoded input; never nested output. */
  activity: string;
}

// The cancellation text goes through the same authoritative clamp as every other
// model-visible result (maxOutputBytes = 0 yields empty text).
const cancelledResult = (
  calls: ReadonlyArray<CodeModeCallEntry>,
  maxOutputBytes: number,
): AgentToolResult<CodeModeToolDetails> => ({
  content: [{ type: "text", text: clampModelVisibleText("Execution cancelled.", maxOutputBytes) }],
  details: { ...callEntryDetails(calls), cancelled: true },
});

export type CodeModeToolExecute = (
  toolCallId: string,
  params: { code: string; intent?: string | undefined },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CodeModeToolDetails> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<CodeModeToolDetails>>;

export const makeCodeModeToolExecute =
  (environment: CodeModeExecutionEnvironment): CodeModeToolExecute =>
  async (toolCallId, params, signal, onUpdate, ctx) => {
    // Defensive gate: a stale definition can remain registered after replacement, and the
    // session's availability can change between registration and execution. With no current
    // state there is no configured clamp, so the refusal is the fixed bounded constant; a
    // current-but-unavailable session clamps the same refusal through its own budget.
    const state = environment.getState();
    if (!environment.isCurrent() || state === undefined) {
      throw new Error(CODE_MODE_UNAVAILABLE_MESSAGE);
    }
    if (!state.available) {
      throw new Error(
        clampModelVisibleText(CODE_MODE_UNAVAILABLE_MESSAGE, state.config.maxOutputBytes),
      );
    }
    const { config } = state;

    const calls: MutableCallEntry[] = [];
    // A function read defeats stale control-flow narrowing: the host aborts concurrently.
    const aborted = () => signal?.aborted === true;
    if (aborted()) return cancelledResult(calls, config.maxOutputBytes);

    const source = checkSourceSize(params.code, config.maxSourceBytes);
    if (!source.ok) throw new Error(clampModelVisibleText(source.message, config.maxOutputBytes));

    const publisher = makeGuardedToolUpdatePublisher(onUpdate, environment.isCurrent);
    const budget = makeCumulativeOutputBudget(config.maxCumulativeChildOutputBytes);
    const dispatch = makeNestedPiToolDispatch({
      definitions: environment.definitions,
      ctx,
      toolCallId,
      signal,
    });

    const execution = CodeMode.execute({
      code: params.code,
      tools: makeExecutionGuestTools(dispatch, budget),
      limits: {
        timeoutMs: config.timeoutMs,
        maxToolCalls: config.maxToolCalls,
        maxOutputBytes: config.maxOutputBytes,
      },
      onToolCallStart: ({ index, name, input }) =>
        Effect.sync(() => {
          calls[index] = {
            tool: name,
            status: "running",
            activity: describeNestedActivity(name, input),
          };
          publisher.publish(progressResult(calls));
        }),
      onToolCallEnd: ({ index, outcome }) =>
        Effect.sync(() => {
          const current = calls[index];
          if (current !== undefined) {
            current.status = outcome === "success" ? "completed" : "error";
          }
          publisher.publish(progressResult(calls));
        }),
    });

    let result: CodeMode.Result;
    try {
      result = await environment.runInSession(execution, signal);
    } catch (error) {
      // Interruption: outer abort, or the session runtime was replaced/shut down mid-run.
      publisher.settle();
      if (aborted() || !environment.isCurrent()) {
        return cancelledResult(calls, config.maxOutputBytes);
      }
      // Unexpected runtime error: the composed message (which embeds a message an adapter
      // or hostile nested layer influenced) is clamped before the Error is constructed.
      throw new Error(
        clampModelVisibleText(
          `code_mode execution did not complete: ${
            error instanceof Error ? error.message : String(error)
          }`,
          config.maxOutputBytes,
        ),
      );
    }

    publisher.settle();
    if (aborted()) return cancelledResult(calls, config.maxOutputBytes);

    // One final clamp over the entire model-visible text - success string or thrown-failure
    // string - so the model never sees more than maxOutputBytes after the extension has
    // appended logs, separators, diagnostic framing, and any runtime truncation markers. The
    // failure message is clamped *before* the Error is constructed, so a hostile program's
    // huge thrown string never materializes in full inside the thrown Error.
    if (!result.ok) {
      throw new Error(clampModelVisibleText(formatCodeModeFailure(result), config.maxOutputBytes));
    }
    return {
      content: [
        {
          type: "text",
          text: clampModelVisibleText(
            formatCodeModeSuccess(result, config.maxOutputBytes),
            config.maxOutputBytes,
          ),
        },
      ],
      details: {
        ...callEntryDetails(calls),
        ...(result.truncated === true ? { truncated: true } : {}),
      },
    };
  };
