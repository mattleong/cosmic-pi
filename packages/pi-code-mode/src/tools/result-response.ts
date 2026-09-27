import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { CodeModeResult } from "../boundary/codemode-runtime.ts";
import { commitPreparedResult } from "../boundary/host-result-commit.ts";
import type { ResultCapture, ExecutionOutcome } from "../results/model.ts";
import { projectResultPage } from "../results/projection.ts";
import type { ResultsContract } from "../results/service.ts";
import {
  formatExecutionReceipts,
  hasCompleteReadOnlyReceipts,
  projectInitialReceipts,
  type ExecutionReceipts,
} from "./execution-receipts.ts";
import {
  formatCodeModeFailure,
  formatCodeModeSuccess,
  type CodeModeToolDetails,
} from "./format.ts";
import { clampModelVisibleText, utf8ByteLength } from "./limits.ts";
import { composeRecoveryResponse } from "./recovery-response.ts";

export function makeResultResponse(input: {
  readonly maxBytes: number;
  readonly results: ResultsContract | undefined;
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
  readonly current: () => boolean;
  readonly aborted: () => boolean;
  readonly capture: () => ResultCapture;
  readonly settle: () => CodeModeToolDetails;
  readonly receipts: () => ExecutionReceipts;
  readonly nestedOutputLost: () => boolean;
  readonly retain: (details: CodeModeToolDetails) => void;
}) {
  const finish = (
    result: CodeModeResult | undefined,
    foreignMessage?: string,
  ): Promise<AgentToolResult<CodeModeToolDetails>> => {
    const details = input.settle();
    const receipts = input.receipts();
    const nestedOutputLost = input.nestedOutputLost();
    const needsSafetyBackstop = nestedOutputLost || receipts.unknown > 0;
    const initiallyCancelled = input.aborted() || !input.current();
    // A settled interpreter result remains known even if delivery is later cancelled.
    const outcome: ExecutionOutcome = result
      ? result.ok
        ? "succeeded"
        : "failed"
      : initiallyCancelled
        ? "cancelled"
        : "failed";
    const raw = initiallyCancelled
      ? "Execution cancelled."
      : result === undefined
        ? `code_mode execution did not complete: ${foreignMessage ?? "Unknown failure"}`
        : result.ok
          ? formatCodeModeSuccess(result)
          : formatCodeModeFailure(result);
    const truncated = result?.truncated === true || utf8ByteLength(raw) > input.maxBytes;
    const safetyDisplacesOutput =
      needsSafetyBackstop &&
      composeRecoveryResponse({
        raw,
        recovery: "",
        receipts,
        nestedOutputLost,
        maxBytes: input.maxBytes,
      }).outputTruncated;
    const needsRetainedOutput = outcome !== "succeeded" || truncated || safetyDisplacesOutput;
    const capture = input.capture();
    const receiptText = formatExecutionReceipts(receipts);
    const retainedText =
      outcome === "succeeded"
        ? capture.status === "captured"
          ? capture.text
          : undefined
        : `${receiptText}\n\n${capture.status === "captured" ? capture.text : `Full output unavailable (${capture.reason}).\n${clampModelVisibleText(raw, input.maxBytes)}`}`;
    // A cancelled response never publishes an ID, so it must not spend retention capacity.
    const prepared =
      needsRetainedOutput && retainedText !== undefined && !initiallyCancelled && input.results
        ? input
            .run(
              input.results.prepare(
                retainedText,
                outcome,
                outcome === "succeeded" ? "output" : "failure-receipt",
              ),
            )
            .catch(() => undefined)
        : Promise.resolve(undefined);
    return prepared.then((artifact) => {
      // Preparation runs on the session, outside the already-settled execution fiber.
      // Its Promise may settle after caller cancellation or session revocation.
      const current = input.current();
      const cancelled = initiallyCancelled || input.aborted() || !current;
      const publishReceipt = needsRetainedOutput || needsSafetyBackstop || cancelled;
      // Commit in this turn, after the final recheck. An uncommitted artifact was never stored,
      // so dropping it leaves saved results and their eviction order untouched.
      const resultId =
        cancelled || artifact === undefined ? undefined : commitPreparedResult(artifact);
      const readOnly = hasCompleteReadOnlyReceipts(receipts);
      const replayCaution = readOnly
        ? "Do not rerun the program to recover output."
        : "Do not rerun mutations to recover output.";
      const recovery =
        !needsRetainedOutput && !cancelled
          ? ""
          : resultId
            ? `Read retained ${outcome === "succeeded" ? "output" : "failure receipt"} without rerunning: code_mode({action:"result.read",id:"${resultId}"}). Original execution: ${outcome}.${capture.status === "unavailable" ? ` Full output unavailable (${capture.reason}).` : ""}\n`
            : `Full output unavailable (${!current ? "revoked" : cancelled ? "cancelled" : capture.status === "unavailable" ? capture.reason : "retention-limit"}). ${replayCaution} Original execution: ${outcome}.\n`;
      const visibleRaw = cancelled ? "Execution cancelled." : raw;
      const composed = publishReceipt
        ? composeRecoveryResponse({
            raw: visibleRaw,
            recovery,
            receipts,
            nestedOutputLost,
            maxBytes: input.maxBytes,
          })
        : {
            text: clampModelVisibleText(visibleRaw, input.maxBytes),
            truncated: utf8ByteLength(visibleRaw) > input.maxBytes,
          };
      let text = composed.text;
      let initialPreview: CodeModeToolDetails["initialPreview"];
      if (
        !cancelled &&
        !needsSafetyBackstop &&
        outcome === "succeeded" &&
        truncated &&
        resultId !== undefined &&
        capture.status === "captured"
      ) {
        const receiptProjection = projectInitialReceipts(receipts);
        const page = projectResultPage(
          {
            id: resultId,
            text: capture.text,
            outcome: "succeeded",
            kind: "output",
            cost: 0,
          },
          0,
          Math.min(capture.text.length, input.maxBytes),
          input.maxBytes,
          {
            includeRecovery: true,
            ...(receiptProjection.receiptMode !== "none" && {
              receipts: receiptProjection.evidence,
            }),
          },
        );
        if (page.presentation.status === "page") {
          text = page.text;
          initialPreview = {
            ...page.presentation,
            originalOutcome: "succeeded",
            kind: "output",
            receiptMode: receiptProjection.receiptMode,
          };
        }
      }
      const finalDetails: CodeModeToolDetails = {
        ...details,
        ...(publishReceipt && { executionReceipts: receipts }),
        ...(resultId && { resultId, ...(initialPreview && { initialPreview }) }),
        ...((truncated || composed.truncated) && { truncated: true }),
        ...(cancelled && { cancelled: true }),
        ...("notesOffset" in composed &&
          composed.notesOffset !== undefined &&
          text === composed.text && { notesOffset: composed.notesOffset }),
        ...(!cancelled &&
          result?.ok && { outputKind: Predicate.isString(result.value) ? "text" : "structured" }),
      };
      if (!cancelled && outcome === "failed") {
        input.retain(finalDetails);
        throw new Error(text);
      }
      return { content: [{ type: "text", text }], details: finalDetails };
    });
  };
  return {
    success: (result: CodeModeResult) => finish(result),
    failure: (message: string) => finish(undefined, message),
  };
}
