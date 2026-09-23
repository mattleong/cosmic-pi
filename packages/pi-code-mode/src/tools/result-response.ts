import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { CodeModeResult } from "../boundary/codemode-runtime.ts";
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
import { projectFailurePresentation } from "./failure-evidence.ts";
import { clampModelVisibleText, utf8ByteLength } from "./limits.ts";

export function makeResultResponse(input: {
  readonly maxBytes: number;
  readonly results: ResultsContract | undefined;
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
  readonly current: () => boolean;
  readonly aborted: () => boolean;
  readonly capture: () => ResultCapture;
  readonly settle: () => CodeModeToolDetails;
  readonly receipts: () => ExecutionReceipts;
  readonly retain: (details: CodeModeToolDetails) => void;
}) {
  const finish = (
    result: CodeModeResult | undefined,
    foreignMessage?: string,
  ): Promise<AgentToolResult<CodeModeToolDetails>> => {
    const details = input.settle();
    const receipts = input.receipts();
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
    const needsReceipt = outcome !== "succeeded" || truncated;
    const capture = input.capture();
    const receiptText = formatExecutionReceipts(receipts);
    const retainedText =
      outcome === "succeeded"
        ? capture.status === "captured"
          ? capture.text
          : undefined
        : `${receiptText}\n\n${capture.status === "captured" ? capture.text : `Full output unavailable (${capture.reason}).\n${clampModelVisibleText(raw, input.maxBytes)}`}`;
    const put =
      needsReceipt && retainedText !== undefined && input.current() && input.results
        ? input
            .run(
              input.results.put(
                retainedText,
                outcome,
                outcome === "succeeded" ? "output" : "failure-receipt",
              ),
            )
            .catch(() => undefined)
        : Promise.resolve(undefined);
    return put.then((id) => {
      // Retention runs on the session, outside the already-settled execution fiber.
      // Its Promise may settle after caller cancellation or session revocation.
      const current = input.current();
      const cancelled = initiallyCancelled || input.aborted() || !current;
      const publishReceipt = needsReceipt || cancelled;
      const resultId = !cancelled ? id : undefined;
      const readOnly = hasCompleteReadOnlyReceipts(receipts);
      const replayCaution = readOnly
        ? "Do not rerun the program to recover output."
        : "Do not rerun mutations to recover output.";
      const recovery = !publishReceipt
        ? ""
        : resultId
          ? `Read retained ${outcome === "succeeded" ? "output" : "failure receipt"} without rerunning: code_mode({action:"result.read",id:"${resultId}"}). Original execution: ${outcome}.${capture.status === "unavailable" ? ` Full output unavailable (${capture.reason}).` : ""}\n`
          : `Full output unavailable (${!current ? "revoked" : cancelled ? "cancelled" : capture.status === "unavailable" ? capture.reason : "retention-limit"}). ${replayCaution} Original execution: ${outcome}.\n`;
      const composed = `${recovery}${publishReceipt && receiptText ? `${receiptText}\n\n` : ""}${cancelled ? "Execution cancelled." : raw}`;
      let text = clampModelVisibleText(composed, input.maxBytes);
      let initialPreview: CodeModeToolDetails["initialPreview"];
      if (
        !cancelled &&
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
        ...((truncated || text !== composed) && { truncated: true }),
        ...(cancelled && { cancelled: true }),
        ...(!cancelled &&
          result?.ok && { outputKind: Predicate.isString(result.value) ? "text" : "structured" }),
      };
      if (!cancelled && outcome === "failed") {
        const presentation = result && !result.ok ? projectFailurePresentation(result) : undefined;
        input.retain({
          ...finalDetails,
          ...(presentation && { failurePresentation: presentation }),
        });
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
