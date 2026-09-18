/**
 * One `code_mode` execution: defensive session gating, host limits, guest catalog assembly,
 * runtime execution with composed cancellation, bounded progress, and model-safe results.
 */
// Pi tool execution is a Promise-shaped host boundary.
import * as Predicate from "effect/Predicate";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { captureBuiltinCompactPolicy, projectBuiltinCompactSummary } from "pi-code-previews";
import { makeCompactEvidence, type CompactReceipt } from "./compact-evidence.ts";
import { invokeHostCallback } from "pi-cosmic-core";
import { projectMcpCompactSummary, MCP_CODE_MODE_MAX_OUTPUT_BYTES } from "pi-mcp/code-mode";
import { makeMcpDispatch } from "../boundary/host-mcp.ts";
import { CodeMode, type CodeModeResult } from "../boundary/codemode-runtime.ts";
import { makeBackgroundTaskDispatch } from "../boundary/host-background-task.ts";
import {
  makeNestedPiToolDispatch,
  type NestedPiToolDefinitions,
} from "../boundary/host-builtin-tools.ts";
import { makeGuardedToolUpdatePublisher } from "../boundary/host-tool-update.ts";
import { makeChildTimings } from "../boundary/host-child-timing.ts";
import type { CodeModeState } from "../config/store.ts";
import { projectFailurePresentation } from "./failure-evidence.ts";
import { describeNestedSubject } from "./compact-subject.ts";
import { makeExecutionGuestTools } from "./catalog.ts";
import {
  callEntryDetails,
  formatCodeModeFailure,
  formatCodeModeSuccess,
  formatForeignRejection,
  progressResult,
  type LiveChildTiming,
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
  /** Pi built-in definitions captured for this registration's cwd and platform. */
  readonly definitions: NestedPiToolDefinitions;
  /** Shared event bus used only for the explicit Background Tasks and MCP protocols. */
  readonly events: ExtensionAPI["events"];
  /** Stable Pi session id captured at activation; absence makes the adapter fail closed. */
  readonly sessionId: string | undefined;
  /** Runtime execution boundary; injectable for compatibility tests. */
  readonly executeCodeMode?: typeof CodeMode.execute;
  /** One-shot handoff to the `tool_result` hook for failures Pi converts to details `{}`. */
  readonly retainFailureDetails?: (toolCallId: string, details: CodeModeToolDetails) => void;
}

const MAX_TRACKED_CALL_ENTRIES = 256;
/** Hard ceiling for one structured protocol result before schema decoding or JSON admission. */
const MAX_BACKGROUND_TASK_PROTOCOL_OUTPUT_BYTES = 16 * 1_024 * 1_024;

type MutableCallCounts = { -readonly [Key in keyof CodeModeCallCounts]: CodeModeCallCounts[Key] };

interface MutableCallEntry {
  compact?: CompactReceipt;
  tool: string;
  status: CodeModeCallEntry["status"];
  subject?: string;
  durationMs?: number;
  liveTiming?: LiveChildTiming;
}

const snapshotCalls = (
  calls: ReadonlyMap<number, MutableCallEntry>,
): ReadonlyArray<CodeModeCallEntry> => Array.from(calls.values(), (call) => ({ ...call }));

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
  calls: ReadonlyMap<number, MutableCallEntry>,
  counts: MutableCallCounts,
): boolean => {
  let changed = false;
  for (const call of calls.values()) {
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
  details: ReturnType<typeof callEntryDetails>,
  maxOutputBytes: number,
): AgentToolResult<CodeModeToolDetails> => ({
  content: [{ type: "text", text: clampModelVisibleText("Execution cancelled.", maxOutputBytes) }],
  details: {
    ...details,
    cancelled: true,
    truncated:
      clampModelVisibleText("Execution cancelled.", maxOutputBytes) !== "Execution cancelled.",
  },
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

      const calls = new Map<number, MutableCallEntry>();
      const childTimings = makeChildTimings();
      const presentationCwd = invokeHostCallback(() => ctx.cwd, undefined);
      // `/reload` refreshes this TypeScript extension but Node can retain the already-imported
      // runtime JS module. Older runtime instances emit only the legacy start/end hooks. Their
      // indices are unique within an execution; their negative IDs stay disjoint from modern
      // non-negative lifecycle IDs, so settled entries can retain the same map key.
      const counts = emptyCounts();
      const compact = makeCompactEvidence((id, receipt) => {
        const call = calls.get(id);
        if (call !== undefined) call.compact = receipt;
      });
      // Adapter completion is not guest delivery. Only the terminal runtime hook observes
      // output-schema decoding and the interpreter's stricter data boundary.
      const returnedOutputs = new Set<number>();
      const endDelivery = (fiber: number, failed: boolean) => {
        const id = compact.identity(fiber);
        if (id !== undefined && returnedOutputs.delete(id) && failed) compact.deliveryFailure(id);
        compact.end(fiber);
      };
      const policy = invokeHostCallback(() => captureBuiltinCompactPolicy(), undefined);
      const progress = () => {
        const result = progressResult(snapshotCalls(calls), counts);
        return {
          ...result,
          details: {
            ...result.details,
            compactAttention: compact.snapshot(),
          },
        };
      };
      const publisher = makeGuardedToolUpdatePublisher(onUpdate, environment.isCurrent);
      const publish = () => publisher.publish(progress());
      const publishNow = () => publisher.publishNow(progress());
      const trackQueued = (id: number, entry: MutableCallEntry): boolean => {
        if (counts.total > config.maxToolCalls) return false;
        if (calls.size >= MAX_TRACKED_CALL_ENTRIES) {
          for (const [key, call] of calls) {
            if (call.status !== "queued" && call.status !== "running") {
              calls.delete(key);
              break;
            }
          }
          if (calls.size >= MAX_TRACKED_CALL_ENTRIES) return false;
        }
        calls.set(id, entry);
        return true;
      };
      const aborted = () => signal?.aborted === true;
      if (aborted()) return cancelledResult(callEntryDetails([], counts), config.maxOutputBytes);

      const sourceRefusal = checkSourceSize(params.code, config.maxSourceBytes);
      if (sourceRefusal !== undefined) {
        throw new Error(clampModelVisibleText(sourceRefusal, config.maxOutputBytes));
      }

      const attempt = (): Promise<AgentToolResult<CodeModeToolDetails>> => {
        // Give the host one leading-edge snapshot before interpreter work begins. Row admission
        // and enriched running labels publish synchronously into Pi's next frame; status-only
        // snapshots are frame-coalesced, with the newest state flushed on settlement.
        publisher.publish(progressResult([], counts));
        const budget = makeCumulativeOutputBudget(config.maxCumulativeChildOutputBytes);
        const execution = Effect.flatMap(Clock.currentTimeMillis, (startedAt) => {
          const dispatch = makeNestedPiToolDispatch({
            definitions: environment.definitions,
            ctx,
            toolCallId,
            observationId: compact.identity,
            onDeliveryFailure: compact.deliveryFailure,
            observe: (id, name, args, result, isError) =>
              compact.observe(id, () => {
                if (policy === undefined || presentationCwd === undefined || name === "powershell")
                  return undefined;
                return projectBuiltinCompactSummary(name, {
                  ...policy,
                  phase: "settled",
                  args,
                  result,
                  cwd: presentationCwd,
                  isError,
                  beforeWrite: { kind: "unknown" },
                });
              }),
          });
          const dispatchBackgroundTask = makeBackgroundTaskDispatch({
            deadlineMillis: startedAt + config.timeoutMs,
            events: environment.events,
            sessionId: environment.sessionId,
            toolCallId,
            maxOutputBytes: () =>
              Math.min(budget.remaining(), MAX_BACKGROUND_TASK_PROTOCOL_OUTPUT_BYTES),
            missingPresentation: compact.missing,
            observationId: compact.identity,
            onDeliveryFailure: compact.deliveryFailure,
            observePresentation: (id, receipt) => {
              if (receipt.incomplete || receipt.overflow) compact.missing();
              compact.observe(id, () => receipt.summary);
            },
          });

          const dispatchMcp = makeMcpDispatch({
            events: environment.events,
            sessionId: environment.sessionId,
            toolCallId,
            maxOutputBytes: () => Math.min(budget.remaining(), MCP_CODE_MODE_MAX_OUTPUT_BYTES),
            observationId: compact.identity,
            observePresentation: (id, args, observation, reply) =>
              compact.observe(id, () => {
                if (observation.incomplete) compact.missing();
                const projected =
                  reply === undefined
                    ? undefined
                    : projectMcpCompactSummary({
                        phase: "settled",
                        args,
                        result: { details: reply },
                        isError: observation.isError,
                      });
                if (projected !== undefined && !observation.incomplete) return projected;
                // Heading-only projection does not claim operation success.
                const heading = projectMcpCompactSummary({
                  phase: "running",
                  args,
                  result: undefined,
                  isError: false,
                });
                return {
                  action: heading?.action ?? args.action,
                  subject: heading?.subject ?? "MCP",
                  outcome:
                    observation.incomplete || observation.outcome === "unknown"
                      ? "uncertain"
                      : observation.isError || observation.outcome === "not-sent"
                        ? "error"
                        : "warning",
                  issues: observation.issues,
                  notices: observation.notices.map((text) => ({ kind: "warning" as const, text })),
                };
              }),
          });

          return (environment.executeCodeMode ?? CodeMode.execute)({
            code: params.code,
            tools: makeExecutionGuestTools(dispatch, dispatchBackgroundTask, dispatchMcp, budget, {
              includePowerShell: environment.definitions.powershell !== undefined,
              observationId: compact.identity,
              onDeliveryFailure: compact.deliveryFailure,
              onOutputReturned: (id) => {
                if (id !== undefined) returnedOutputs.add(id);
              },
            }),
            limits: {
              timeoutMs: config.timeoutMs,
              maxToolCalls: config.maxToolCalls,
              maxOutputBytes: config.maxOutputBytes,
            },
            onToolCallLifecycle: (event) =>
              Effect.flatMap(Effect.fiberId, (fiber) =>
                Effect.sync(() => {
                  if (event.status !== "queued" && event.status !== "running")
                    endDelivery(fiber, event.status !== "succeeded");
                  if (event.status === "queued") {
                    compact.admit(event.name);
                    counts.total += 1;
                    counts.queued += 1;
                    const entry: MutableCallEntry = {
                      tool: event.name,
                      status: "queued",
                    };
                    if (!trackQueued(event.id, entry)) return;
                  } else {
                    const entry = calls.get(event.id);
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
                      if (event.status !== "running") {
                        childTimings.stop(entry.liveTiming);
                        delete entry.liveTiming;
                        entry.durationMs = event.durationMs;
                      }
                    } else if (event.status === "running") {
                      counts.queued -= 1;
                      counts.running += 1;
                      // The start hook immediately follows and publishes the exact hidden counts.
                      return;
                    } else {
                      counts[event.started ? "running" : "queued"] -= 1;
                      counts[statusCountKey(nextStatus)] += 1;
                    }
                    // The start hook immediately follows a tracked running event and enriches the
                    // row. Publish that one snapshot instead of two equivalent running updates.
                    if (event.status === "running") return;
                  }
                  if (event.status === "queued") publishNow();
                  else publish();
                }),
              ),
            onToolCallStart: ({ index, lifecycleId, name, input }) =>
              Effect.flatMap(Effect.fiberId, (fiber) =>
                Effect.sync(() => {
                  const id = lifecycleId ?? -(index + 1);
                  compact.start(fiber, id);
                  let current = calls.get(id);
                  if (current === undefined && lifecycleId === undefined) {
                    compact.admit(name);
                    counts.total += 1;
                    counts.running += 1;
                    current = {
                      tool: name,
                      status: "running",
                    };
                    trackQueued(id, current);
                  } else if (current !== undefined) {
                    transitionCall(current, "running", counts);
                  }
                  if (current !== undefined) {
                    if (calls.has(id) && current.liveTiming === undefined) {
                      const timing = childTimings.start();
                      if (timing !== undefined) current.liveTiming = timing;
                    }
                    const subject =
                      presentationCwd === undefined
                        ? undefined
                        : describeNestedSubject(name, input, presentationCwd);
                    if (subject !== undefined) current.subject = subject;
                    else delete current.subject;
                  }
                  // Do not place a newly admitted/enriched row behind our frame timer: Pi already has
                  // a render queued, so synchronous delivery lets the row join that next host frame.
                  publishNow();
                }),
              ),
            onToolCallEnd: ({ index, lifecycleId, outcome, durationMs }) =>
              Effect.flatMap(Effect.fiberId, (fiber) =>
                Effect.sync(() => {
                  // Modern runtimes emit one authoritative terminal lifecycle event immediately after
                  // this compatibility hook. Avoid publishing and rebuilding the same settled row twice.
                  if (lifecycleId !== undefined) return;
                  endDelivery(fiber, outcome !== "success");
                  const id = -(index + 1);
                  const current = calls.get(id);
                  const nextStatus = outcome === "success" ? "completed" : "error";
                  if (current !== undefined) {
                    transitionCall(current, nextStatus, counts);
                    childTimings.stop(current.liveTiming);
                    delete current.liveTiming;
                    current.durationMs = durationMs;
                  } else {
                    // The legacy call was counted but its row exceeded the bounded host-side cap.
                    counts.running -= 1;
                    counts[statusCountKey(nextStatus)] += 1;
                  }
                  publish();
                }),
              ),
          });
        });

        const settleProgress = (): CodeModeToolDetails => {
          childTimings.close();
          // Legacy hooks cannot prove delivery for interrupted calls that never emit an end.
          for (const id of returnedOutputs) compact.deliveryFailure(id);
          returnedOutputs.clear();
          for (const call of calls.values()) delete call.liveTiming;
          const changed = settlePendingAsCancelled(calls, counts);
          counts.cancelled += counts.queued + counts.running;
          counts.queued = 0;
          counts.running = 0;
          const snapshot = snapshotCalls(calls);
          compact.close();
          if (changed) publisher.publish(progress());
          publisher.settle();
          return {
            ...callEntryDetails(snapshot, counts),
            compactAttention: compact.snapshot(),
          };
        };

        const settleAfterFailure = (message: string): AgentToolResult<CodeModeToolDetails> => {
          const details = settleProgress();
          if (aborted() || !environment.isCurrent()) {
            return cancelledResult(details, config.maxOutputBytes);
          }
          const raw = `code_mode execution did not complete: ${message}`;
          const text = clampModelVisibleText(raw, config.maxOutputBytes);
          environment.retainFailureDetails?.(toolCallId, { ...details, truncated: text !== raw });
          throw new Error(text);
        };

        const settleAfterSuccess = (
          result: CodeModeResult,
        ): AgentToolResult<CodeModeToolDetails> => {
          const settledDetails = settleProgress();
          if (aborted()) return cancelledResult(settledDetails, config.maxOutputBytes);

          const raw = result.ok ? formatCodeModeSuccess(result) : formatCodeModeFailure(result);
          const text = clampModelVisibleText(raw, config.maxOutputBytes);
          const baseDetails: CodeModeToolDetails =
            result.truncated === true || text !== raw
              ? { ...settledDetails, truncated: true }
              : settledDetails;
          if (!result.ok) {
            const failurePresentation = projectFailurePresentation(result);
            environment.retainFailureDetails?.(toolCallId, {
              ...baseDetails,
              ...(failurePresentation && { failurePresentation }),
            });
            throw new Error(text);
          }
          const details: CodeModeToolDetails = {
            ...baseDetails,
            outputKind: Predicate.isString(result.value) ? "text" : "structured",
          };
          return {
            content: [
              {
                type: "text",
                text,
              },
            ],
            details,
          };
        };

        return environment
          .runInSession(execution, signal)
          .then(settleAfterSuccess, (error) => settleAfterFailure(formatForeignRejection(error)));
      };
      return Promise.resolve()
        .then(attempt)
        .finally(() => {
          childTimings.close();
          compact.close();
          publisher.settle();
        });
    });
