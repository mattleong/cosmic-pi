import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { CodeModeResult } from "../boundary/codemode-runtime.ts";
import type { ResultCapture, ExecutionOutcome } from "../results/model.ts";
import type { ResultsContract } from "../results/service.ts";
import { formatExecutionReceipts, type ExecutionReceipts } from "./execution-receipts.ts";
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
    const cancelled = input.aborted() || !input.current();
    const outcome: ExecutionOutcome = cancelled ? "cancelled" : result?.ok ? "succeeded" : "failed";
    const raw = cancelled
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
      const current = input.current();
      const resultId = current ? id : undefined;
      const recovery = !needsReceipt
        ? ""
        : resultId
          ? `Read retained ${outcome === "succeeded" ? "output" : "failure receipt"} without rerunning: code_mode({action:"result.read",id:"${resultId}"}). Original execution: ${outcome}.${capture.status === "unavailable" ? ` Full output unavailable (${capture.reason}).` : ""}\n`
          : `Full output unavailable (${current ? (capture.status === "unavailable" ? capture.reason : "retention-limit") : "revoked"}). Do not rerun mutations to recover output. Original execution: ${outcome}.\n`;
      const composed = `${recovery}${needsReceipt && receiptText ? `${receiptText}\n\n` : ""}${raw}`;
      const text = clampModelVisibleText(composed, input.maxBytes);
      const finalDetails: CodeModeToolDetails = {
        ...details,
        ...(needsReceipt && { executionReceipts: receipts }),
        ...(resultId && { resultId }),
        ...((truncated || text !== composed) && { truncated: true }),
        ...(cancelled && { cancelled: true }),
        ...(!cancelled &&
          result?.ok && { outputKind: Predicate.isString(result.value) ? "text" : "structured" }),
      };
      if (outcome === "failed") {
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
