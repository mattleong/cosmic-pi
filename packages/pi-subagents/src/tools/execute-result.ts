import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessageArrivals } from "../run/message-watches.ts";
import type { SubagentRunView } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import {
  encodeSubagentContract,
  type SubagentAwaitContract,
  type SubagentContract,
  type SubagentLifecycleContract,
  type SubagentStartContract,
} from "./contract-schema.ts";
import { awaitDetails, compactToolDetails, startDetails } from "./details.ts";
import type {
  CompactSubagentToolDetails,
  SubagentStartAwaitCardDetails,
  SubagentStartEntry,
} from "./details-schema.ts";
import { boundToolOutput, formatActionFailures, formatStartResult } from "./format.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import { formatRunBlocks, runViewBlock } from "./run-block.ts";
import type { SubagentLifecycleInput } from "./schema.ts";
import * as Str from "effect/String";

const ACKNOWLEDGEMENT_HEADINGS = {
  interrupt: "Interrupted; these runs are paused.",
  stop: "Stop requested.",
} as const satisfies Record<SubagentLifecycleInput["action"], string>;

/** One block per target, without its report, which only an await or notice delivers. */
const managementAcknowledgement = (
  action: SubagentLifecycleInput["action"],
  runs: ReadonlyArray<SubagentRunView>,
): string =>
  runs.length === 0
    ? ""
    : formatRunBlocks(
        [ACKNOWLEDGEMENT_HEADINGS[action]],
        Arr.map(runs, (run) => runViewBlock(run, undefined)),
      );

const toolResult = (
  text: string,
  details: SubagentStartAwaitCardDetails | CompactSubagentToolDetails,
  contract: SubagentContract,
): AgentToolResult<unknown> => ({
  // Each part bounds every run's share, so the guard never cuts a delivered outcome.
  content: [{ type: "text", text: boundToolOutput(text) }],
  details,
  structuredContent: encodeSubagentContract(contract),
});

export const presentStartResult = (
  result: {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly startFailures: ReadonlyArray<SubagentStartFailure>;
    readonly startEntries: ReadonlyArray<SubagentStartEntry>;
  },
  contract: SubagentStartContract,
): AgentToolResult<unknown> =>
  toolResult(
    formatStartResult(result.runs, result.startFailures),
    startDetails({
      startEntries: result.startEntries,
      ...(result.startFailures.length > 0 && { startFailures: result.startFailures }),
    }),
    contract,
  );

export const presentAwaitResult = (
  result: {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly contextRuns: ReadonlyArray<SubagentRunView>;
    readonly awaitedRunIds: ReadonlyArray<string>;
    readonly awaitUntil: SubagentAwaitUntil;
    readonly attentionRequired: boolean;
    /** Agent messages delivered to the await's caller during its wait. */
    readonly messages?: AgentMessageArrivals;
    readonly text: string;
  },
  contract: SubagentAwaitContract,
): AgentToolResult<unknown> =>
  toolResult(
    result.text,
    awaitDetails({
      runs: result.runs,
      contextRuns: result.contextRuns,
      awaitedRunIds: result.awaitedRunIds,
      awaitUntil: result.awaitUntil,
      ...(result.attentionRequired && { attentionRequired: true as const }),
      ...(result.messages && { agentMessages: result.messages }),
      // Why the wait ended is the contract's outcome; the cards alone can't tell.
      ...(contract.outcome === "message" && { endedByAgentMessage: true as const }),
    }),
    contract,
  );

/** A lifecycle call has at least one target, so its result names a run or a failure. */
export const presentLifecycleResult = (
  action: SubagentLifecycleInput["action"],
  result: {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly actionFailures: ReadonlyArray<SubagentActionFailure>;
  },
  contract: SubagentLifecycleContract,
): AgentToolResult<unknown> =>
  toolResult(
    Fn.pipe(
      [managementAcknowledgement(action, result.runs), formatActionFailures(result.actionFailures)],
      Arr.filter(Str.isNonEmpty),
      Arr.join("\n\n"),
    ),
    compactToolDetails({
      action,
      runs: result.runs,
      ...(result.actionFailures.length > 0 && { actionFailures: result.actionFailures }),
    }),
    contract,
  );
