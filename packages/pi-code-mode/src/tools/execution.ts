/**
 * One `code_mode` execution: defensive session gating, host limits, guest catalog assembly,
 * runtime execution with composed cancellation, bounded progress, and model-safe results.
 */
// Pi tool execution is a Promise-shaped host boundary.
import * as Predicate from "effect/Predicate";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { CodeMode, type CodeModeResult } from "../boundary/codemode-runtime.ts";
import {
  makeNestedPiToolDispatch,
  type NestedPiToolDefinitions,
} from "../boundary/host-builtin-tools.ts";
import { makeGuardedToolUpdatePublisher } from "../boundary/host-tool-update.ts";
import type { CodeModeState } from "../config/store.ts";
import { makeExecutionGuestTools } from "./catalog.ts";
import {
  callEntryDetails,
  describeNestedActivity,
  formatCodeModeFailure,
  formatCodeModeSuccess,
  progressResult,
  type CodeModeCallCounts,
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
  /** All seven built-in Pi definitions captured for this registration's cwd. */
  readonly definitions: NestedPiToolDefinitions;
  /** Runtime execution boundary; injectable for compatibility tests. */
  readonly executeCodeMode?: typeof CodeMode.execute;
  /** One-shot handoff to the `tool_result` hook for failures Pi converts to details `{}`. */
  readonly retainFailureDetails?: (toolCallId: string, details: CodeModeToolDetails) => void;
}

const MAX_TRACKED_CALL_ENTRIES = 256;

type MutableCallCounts = { -readonly [Key in keyof CodeModeCallCounts]: CodeModeCallCounts[Key] };

interface MutableCallEntry {
  id: number;
  tool: string;
  status: CodeModeCallEntry["status"];
  /** Bounded human-readable label derived from the decoded input; never nested output. */
  activity: string;
  durationMs?: number;
}

const snapshotCalls = (calls: ReadonlyArray<MutableCallEntry>): ReadonlyArray<CodeModeCallEntry> =>
  calls.map(({ tool, status, activity, durationMs }) => {
    const base = { tool, status, activity };
    return durationMs === undefined ? base : { ...base, durationMs };
  });

const emptyCounts = (): MutableCallCounts => ({
  total: 0,
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
});

const statusCountKey = (
  status: CodeModeCallEntry["status"],
): Exclude<keyof CodeModeCallCounts, "total"> =>
  status === "completed" ? "succeeded" : status === "error" ? "failed" : status;

const transitionCall = (
  call: MutableCallEntry,
  status: CodeModeCallEntry["status"],
  counts: MutableCallCounts,
): void => {
  if (call.status === status) return;
  counts[statusCountKey(call.status)] -= 1;
  counts[statusCountKey(status)] += 1;
  call.status = status;
};

const settlePendingAsCancelled = (
  calls: ReadonlyArray<MutableCallEntry>,
  counts: MutableCallCounts,
): boolean => {
  let changed = false;
  for (const call of calls) {
    if (call.status === "queued" || call.status === "running") {
      transitionCall(call, "cancelled", counts);
      changed = true;
    }
  }
  return changed;
};

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
  (toolCallId, params, signal, onUpdate, ctx) =>
    // Synchronous refusals become rejections here, exactly as the prior async form produced.
    Promise.resolve().then(() => {
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
      const callById = new Map<number, MutableCallEntry>();
      // `/reload` refreshes this TypeScript extension but Node can retain the already-imported
      // runtime JS module. Older runtime instances emit only the legacy start/end hooks, so keep
      // an independent index for that backward-compatible path instead of assuming lifecycle
      // `queued` events always materialized the row first.
      const legacyCallByIndex = new Map<number, MutableCallEntry>();
      const counts = emptyCounts();
      const publish = () => publisher.publish(progressResult(snapshotCalls(calls), counts));
      const publishNow = () => publisher.publishNow(progressResult(snapshotCalls(calls), counts));
      const trackQueued = (entry: MutableCallEntry): boolean => {
        if (counts.total > config.maxToolCalls) return false;
        if (calls.length >= MAX_TRACKED_CALL_ENTRIES) {
          const evictedIndex = calls.findIndex((call) => call.status === "completed");
          if (evictedIndex < 0) return false;
          const [evicted] = calls.splice(evictedIndex, 1);
          if (evicted !== undefined) callById.delete(evicted.id);
        }
        calls.push(entry);
        callById.set(entry.id, entry);
        return true;
      };
      const aborted = () => signal?.aborted === true;
      if (aborted()) return cancelledResult([], config.maxOutputBytes);

      const sourceRefusal = checkSourceSize(params.code, config.maxSourceBytes);
      if (sourceRefusal !== undefined) {
        throw new Error(clampModelVisibleText(sourceRefusal, config.maxOutputBytes));
      }

      const publisher = makeGuardedToolUpdatePublisher(onUpdate, environment.isCurrent);
      const attempt = (): Promise<AgentToolResult<CodeModeToolDetails>> => {
        // Give the host one leading-edge snapshot before interpreter work begins. Row admission
        // and enriched running labels publish synchronously into Pi's next frame; status-only
        // snapshots are frame-coalesced, with the newest state flushed on settlement.
        publisher.publish(progressResult([], counts));
        const budget = makeCumulativeOutputBudget(config.maxCumulativeChildOutputBytes);
        const dispatch = makeNestedPiToolDispatch({
          definitions: environment.definitions,
          ctx,
          toolCallId,
          signal,
        });

        const execution = (environment.executeCodeMode ?? CodeMode.execute)({
          code: params.code,
          tools: makeExecutionGuestTools(dispatch, budget),
          limits: {
            timeoutMs: config.timeoutMs,
            maxToolCalls: config.maxToolCalls,
            maxOutputBytes: config.maxOutputBytes,
          },
          onToolCallLifecycle: (event) =>
            Effect.sync(() => {
              if (event.status === "queued") {
                counts.total += 1;
                counts.queued += 1;
                const entry: MutableCallEntry = {
                  id: event.id,
                  tool: event.name,
                  status: "queued",
                  activity: describeNestedActivity(event.name, undefined),
                };
                if (!trackQueued(entry)) return;
              } else {
                const entry = callById.get(event.id);
                const nextStatus =
                  event.status === "running"
                    ? "running"
                    : event.status === "succeeded"
                      ? "completed"
                      : event.status === "failed"
                        ? "error"
                        : "cancelled";
                if (entry !== undefined) {
                  transitionCall(entry, nextStatus, counts);
                  if (event.status !== "running") entry.durationMs = event.durationMs;
                } else {
                  if (event.status !== "running") {
                    counts.queued -= 1;
                    counts[statusCountKey(nextStatus)] += 1;
                  }
                  return;
                }
                // The start hook immediately follows the modern running event and enriches the
                // row with decoded activity. Publish that one snapshot instead of two equivalent
                // running updates; terminal lifecycle events remain authoritative.
                if (event.status === "running") return;
              }
              if (event.status === "queued") publishNow();
              else publish();
            }),
          onToolCallStart: ({ index, lifecycleId, name, input }) =>
            Effect.sync(() => {
              let current =
                lifecycleId === undefined
                  ? legacyCallByIndex.get(index)
                  : callById.get(lifecycleId);
              if (current === undefined && lifecycleId === undefined) {
                counts.total += 1;
                counts.running += 1;
                current = {
                  // Legacy indices are execution-local and disjoint from non-negative lifecycle IDs.
                  id: -(index + 1),
                  tool: name,
                  status: "running",
                  activity: describeNestedActivity(name, input),
                };
                if (trackQueued(current)) legacyCallByIndex.set(index, current);
              } else if (current !== undefined) {
                transitionCall(current, "running", counts);
                current.activity = describeNestedActivity(name, input);
              }
              // Do not place a newly admitted/enriched row behind our frame timer: Pi already has
              // a render queued, so synchronous delivery lets the row join that next host frame.
              publishNow();
            }),
          onToolCallEnd: ({ index, lifecycleId, outcome, durationMs }) =>
            Effect.sync(() => {
              // Modern runtimes emit one authoritative terminal lifecycle event immediately after
              // this compatibility hook. Avoid publishing and rebuilding the same settled row twice.
              if (lifecycleId !== undefined) return;
              const current = legacyCallByIndex.get(index);
              const nextStatus = outcome === "success" ? "completed" : "error";
              if (current !== undefined) {
                transitionCall(current, nextStatus, counts);
                current.durationMs = durationMs;
                legacyCallByIndex.delete(index);
              } else {
                // The legacy call was counted but its row exceeded the bounded host-side cap.
                counts.running -= 1;
                counts[statusCountKey(nextStatus)] += 1;
              }
              publish();
            }),
        });

        const settleAfterFailure = (message: string): AgentToolResult<CodeModeToolDetails> => {
          const changed = settlePendingAsCancelled(calls, counts);
          counts.cancelled += counts.queued + counts.running;
          counts.queued = 0;
          counts.running = 0;
          const details = callEntryDetails(snapshotCalls(calls), counts);
          if (changed) publisher.publish(progressResult(snapshotCalls(calls), counts));
          publisher.settle();
          if (aborted() || !environment.isCurrent()) {
            return {
              ...cancelledResult(snapshotCalls(calls), config.maxOutputBytes),
              details: { ...callEntryDetails(snapshotCalls(calls), counts), cancelled: true },
            };
          }
          environment.retainFailureDetails?.(toolCallId, details);
          throw new Error(
            clampModelVisibleText(
              `code_mode execution did not complete: ${message}`,
              config.maxOutputBytes,
            ),
          );
        };

        const settleAfterSuccess = (
          result: CodeModeResult,
        ): AgentToolResult<CodeModeToolDetails> => {
          const changed = settlePendingAsCancelled(calls, counts);
          counts.cancelled += counts.queued + counts.running;
          counts.queued = 0;
          counts.running = 0;
          if (changed) publisher.publish(progressResult(snapshotCalls(calls), counts));
          publisher.settle();
          if (aborted()) {
            return {
              ...cancelledResult(snapshotCalls(calls), config.maxOutputBytes),
              details: { ...callEntryDetails(snapshotCalls(calls), counts), cancelled: true },
            };
          }

          const callEntry = callEntryDetails(snapshotCalls(calls), counts);
          const baseDetails: CodeModeToolDetails =
            result.truncated === true ? { ...callEntry, truncated: true } : callEntry;
          if (!result.ok) {
            environment.retainFailureDetails?.(toolCallId, baseDetails);
            throw new Error(
              clampModelVisibleText(formatCodeModeFailure(result), config.maxOutputBytes),
            );
          }
          const details: CodeModeToolDetails = {
            ...baseDetails,
            outputKind: Predicate.isString(result.value) ? "text" : "structured",
          };
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
            details,
          };
        };

        return environment
          .runInSession(execution, signal)
          .then(settleAfterSuccess, (error) =>
            settleAfterFailure(error instanceof Error ? error.message : String(error)),
          );
      };
      return Promise.resolve()
        .then(attempt)
        .finally(() => {
          publisher.settle();
        });
    });
