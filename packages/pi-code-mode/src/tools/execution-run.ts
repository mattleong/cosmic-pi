import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { captureBuiltinCompactPolicy, projectBuiltinCompactSummary } from "pi-code-previews";
import { invokeHostCallback } from "pi-cosmic-core";
import { MCP_CODE_MODE_MAX_OUTPUT_BYTES, projectMcpCompactSummary } from "pi-mcp/code-mode";
import { executeProgram } from "../engine/execute.ts";
import { makeMcpDispatch } from "../boundary/host-mcp.ts";
import type { ResultCapture } from "../results/model.ts";
import { captureResult } from "../results/serialize.ts";
import { makeCompactEvidence } from "./compact-evidence.ts";
import {
  emptyCounts,
  settlePendingAsCancelled,
  snapshotCalls,
  statusCountKey,
  transitionCall,
  type MutableCallEntry,
} from "./execution-progress.ts";
import { makeExecutionReceipts } from "./execution-receipts.ts";
import { makeResultResponse } from "./result-response.ts";

import { makeBackgroundTaskDispatch } from "../boundary/host-background-task.ts";
import { makeNestedPiToolDispatch } from "../boundary/host-builtin-tools.ts";
import { makeChildTimings } from "../boundary/host-child-timing.ts";
import { makeGuardedToolUpdatePublisher } from "../boundary/host-tool-update.ts";
import type { CodeModeState } from "../config/store.ts";
import { makeExecutionGuestTools } from "./catalog.ts";
import { describeNestedSubject } from "./compact-subject.ts";
import { describeRefusal } from "./diagnostic-messages.ts";
import {
  callEntryDetails,
  formatForeignRejection,
  progressResult,
  type CodeModeToolDetails,
} from "./format.ts";
import { checkSourceSize, clampModelVisibleText, makeCumulativeOutputBudget } from "./limits.ts";

import type { CodeModeExecutionEnvironment, CodeModeToolExecute } from "./execution.ts";
const MAX_TRACKED_CALL_ENTRIES = 256;
/** Hard ceiling for one structured protocol result before schema decoding or JSON admission. */
const MAX_BACKGROUND_TASK_PROTOCOL_OUTPUT_BYTES = 16 * 1_024 * 1_024;

// The cancellation text goes through the same authoritative clamp as every other
// model-visible result (maxOutputBytes = 0 yields empty text).
export const cancelledResult = (
  details: ReturnType<typeof callEntryDetails>,
  maxOutputBytes: number,
): AgentToolResult<CodeModeToolDetails> => {
  const text = clampModelVisibleText("Execution cancelled.", maxOutputBytes);
  return {
    content: [{ type: "text", text }],
    details: { ...details, cancelled: true, truncated: text !== "Execution cancelled." },
  };
};

export function runCodeModeExecution(
  environment: CodeModeExecutionEnvironment,
  config: CodeModeState["config"],
  toolCallId: string,
  params: { readonly code: string },
  signal: AbortSignal | undefined,
  onUpdate: Parameters<CodeModeToolExecute>[3],
  ctx: ExtensionToolContext,
) {
  const receipts = makeExecutionReceipts();
  let capture: ResultCapture = { status: "unavailable", reason: "runtime-unavailable" };
  let acceptingCapture = true;

  const calls = new Map<number, MutableCallEntry>();
  // Calls whose tool began; a failed call outside this set was refused before it ran.
  const sent = new Set<number>();
  const childTimings = makeChildTimings();
  const presentationCwd = invokeHostCallback(() => ctx.cwd, undefined);
  const counts = emptyCounts();
  const compact = makeCompactEvidence((id, receipt) => {
    const call = calls.get(id);
    if (call !== undefined) call.compact = receipt;
  });
  // Adapter completion is not guest delivery. Only the terminal lifecycle event observes
  // output-schema decoding and delivery to the program.
  const returnedOutputs = new Set<number>();
  const recordDeliveryFailure = (id: number | undefined) => {
    receipts.recordOutputLoss();
    compact.deliveryFailure(id);
  };
  const endDelivery = (fiber: number, failed: boolean) => {
    const id = compact.identity(fiber);
    const returned = id !== undefined && returnedOutputs.delete(id);
    if (returned && failed) recordDeliveryFailure(id);
    receipts.delivery(id, returned && !failed);
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
    // Past the limit, only the first refused call gets a row; it explains the refusal.
    if (counts.total > config.maxToolCalls + 1) return false;
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
  const aborted = () => invokeHostCallback(() => signal?.aborted === true, true);
  if (aborted()) return cancelledResult(callEntryDetails([], counts), config.maxOutputBytes);
  const gated =
    <Args extends ReadonlyArray<unknown>, A, E>(run: (...args: Args) => Effect.Effect<A, E>) =>
    (...args: Args) =>
      Effect.suspend(() =>
        environment.isCurrent() && !aborted() ? run(...args) : Effect.interrupt,
      );

  const sourceRefusal = checkSourceSize(params.code, config.maxSourceBytes);
  if (sourceRefusal !== undefined) {
    throw new Error(clampModelVisibleText(sourceRefusal, config.maxOutputBytes));
  }

  const attempt = (): Promise<AgentToolResult<CodeModeToolDetails>> => {
    // Give the host one leading-edge snapshot before program work begins. Row admission
    // and enriched running labels publish synchronously into Pi's next frame; status-only
    // snapshots are frame-coalesced, with the newest state flushed on settlement.
    // The leading snapshot carries the (empty) attention ledger, so the compact row keeps its
    // heading from the first frame.
    publisher.publish(progress());
    const budget = makeCumulativeOutputBudget(config.maxCumulativeChildOutputBytes);
    const execution = Effect.flatMap(Clock.currentTimeMillis, (startedAt) => {
      const dispatch = makeNestedPiToolDispatch({
        definitions: environment.definitions,
        ctx,
        toolCallId,
        observationId: compact.identity,
        onOperation: receipts.observe,
        onDeliveryFailure: recordDeliveryFailure,
        observe: (id, name, args, result, isError) =>
          compact.observe(id, () => {
            if (policy === undefined || presentationCwd === undefined) return undefined;
            return projectBuiltinCompactSummary(name, {
              ...policy,
              phase: "settled",
              args,
              result,
              cwd: presentationCwd,
              isError,
              beforeWrite: { kind: "not-captured" },
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
        onOperation: receipts.observe,
        observationId: compact.identity,
        onDeliveryFailure: recordDeliveryFailure,
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
        onDeliveryFailure: recordDeliveryFailure,
        observePresentation: (id, args, observation, reply) => {
          receipts.observe(id, observation.outcome, observation.resultId, observation.isError);
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
            // Incomplete summaries keep the observation's own evidence.
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
            };
          });
        },
      });

      return (environment.executeCodeMode ?? executeProgram)({
        code: params.code,
        cwd: environment.cwd,
        onResult: (result) => {
          if (acceptingCapture && environment.isCurrent()) capture = captureResult(result);
        },
        tools: makeExecutionGuestTools(
          gated(dispatch),
          gated(dispatchBackgroundTask),
          gated(dispatchMcp),
          budget,
          {
            observationId: compact.identity,
            onDeliveryFailure: recordDeliveryFailure,
            onOutputReturned: (id) => {
              if (id !== undefined) returnedOutputs.add(id);
            },
          },
        ),
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
                receipts.admit(event.id, event.name);
                counts.total += 1;
                counts.queued += 1;
                const entry: MutableCallEntry = {
                  tool: event.name,
                  status: "queued",
                };
                if (!trackQueued(event.id, entry)) return;
              } else {
                if (event.status !== "running") {
                  // Only a listed row can explain its refusal; untracked calls stay counted only.
                  if (
                    event.status === "failed" &&
                    event.failure &&
                    !sent.has(event.id) &&
                    calls.has(event.id)
                  )
                    compact.refused(event.id, {
                      severity: "error",
                      code: `not-sent:${event.failure.kind}`,
                      message: describeRefusal(event.failure),
                    });
                  sent.delete(event.id);
                }
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
        onToolCallStart: ({ lifecycleId: id, name, input }) =>
          Effect.flatMap(Effect.fiberId, (fiber) =>
            Effect.sync(() => {
              if (id === undefined) return;
              sent.add(id);
              compact.start(fiber, id);
              const current = calls.get(id);
              if (current !== undefined) transitionCall(current, "running", counts);
              receipts.start(id, name);
              const subject =
                presentationCwd === undefined
                  ? undefined
                  : describeNestedSubject(name, input, presentationCwd);
              receipts.target(id, subject);
              if (current !== undefined) {
                if (current.liveTiming === undefined) {
                  const timing = childTimings.start();
                  if (timing !== undefined) current.liveTiming = timing;
                }
                if (subject !== undefined) current.subject = subject;
                else delete current.subject;
              }
              // Do not place a newly admitted/enriched row behind our frame timer: Pi already has
              // a render queued, so synchronous delivery lets the row join that next host frame.
              publishNow();
            }),
          ),
      });
    });

    const settleProgress = (): CodeModeToolDetails => {
      acceptingCapture = false;
      childTimings.close();
      // Interrupted calls that never emit a terminal lifecycle event cannot prove delivery.
      for (const id of returnedOutputs) recordDeliveryFailure(id);
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

    const response = makeResultResponse({
      maxBytes: config.maxOutputBytes,
      results: environment.results,
      run: (effect) => environment.runInSession(effect),
      current: () => environment.isCurrent() && environment.getState()?.available === true,
      aborted,
      capture: () => capture,
      settle: settleProgress,
      receipts: receipts.close,
      nestedOutputLost: receipts.hasOutputLoss,
      retain: (details) => environment.retainFailureDetails?.(toolCallId, details),
    });
    return environment
      .runInSession(execution, signal)
      .then(response.success, (error) => response.failure(formatForeignRejection(error)));
  };
  return Promise.resolve()
    .then(attempt)
    .finally(() => {
      acceptingCapture = false;
      receipts.close();
      childTimings.close();
      compact.close();
      publisher.settle();
    });
}
