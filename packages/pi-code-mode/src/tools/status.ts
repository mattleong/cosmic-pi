import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CodeModeConfig } from "../config/schema.ts";
import { callEntryDetails, type CodeModeToolDetails } from "./format.ts";
import { clampModelVisibleText, utf8ByteLength } from "./limits.ts";

export type CodeModeEffectiveLimits = Readonly<
  Pick<
    CodeModeConfig,
    | "timeoutMs"
    | "maxToolCalls"
    | "maxOutputBytes"
    | "maxSourceBytes"
    | "maxCumulativeChildOutputBytes"
  >
>;

export interface CodeModeStatus {
  readonly action: "status";
  readonly limits: CodeModeEffectiveLimits;
}

export type StatusDetails = CodeModeToolDetails & { readonly status: CodeModeStatus };

export const makeCodeModeStatus = (config: CodeModeConfig): CodeModeStatus =>
  Object.freeze({
    action: "status",
    limits: Object.freeze({
      timeoutMs: config.timeoutMs,
      maxToolCalls: config.maxToolCalls,
      maxOutputBytes: config.maxOutputBytes,
      maxSourceBytes: config.maxSourceBytes,
      maxCumulativeChildOutputBytes: config.maxCumulativeChildOutputBytes,
    }),
  });

export const serializeCodeModeStatus = (status: CodeModeStatus): string => JSON.stringify(status);

export const codeModeStatusFits = (status: CodeModeStatus): boolean =>
  utf8ByteLength(serializeCodeModeStatus(status)) <= status.limits.maxOutputBytes;

const statusBudgetRefusal = (maxOutputBytes: number): string =>
  clampModelVisibleText(
    "Code Mode status unavailable: maxOutputBytes is too small for the complete status JSON. No program or nested tool was run.",
    maxOutputBytes,
  );

/**
 * Projects the live in-memory limits without entering the interpreter, session runner, result
 * store, or any execution budget. The final response still obeys the live output-byte limit.
 */
export const codeModeStatusResult = (config: CodeModeConfig): AgentToolResult<StatusDetails> => {
  const status = makeCodeModeStatus(config);
  const serialized = serializeCodeModeStatus(status);
  return {
    content: [
      {
        type: "text",
        text: codeModeStatusFits(status) ? serialized : statusBudgetRefusal(config.maxOutputBytes),
      },
    ],
    details: { ...callEntryDetails([]), status },
  };
};
