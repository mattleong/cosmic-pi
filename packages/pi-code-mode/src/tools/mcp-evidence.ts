/** Bounded presentation evidence; never retains MCP payloads or request arguments. */
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { McpCodeModeOutput } from "pi-mcp/code-mode";
import { decodeOption } from "./format.ts";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const isCompactPiTool = (name: string): boolean =>
  [
    "pi.read",
    "pi.bash",
    "pi.powershell",
    "pi.edit",
    "pi.write",
    "pi.grep",
    "pi.find",
    "pi.ls",
  ].includes(name);
const Notice = Schema.String.check(Schema.isMaxLength(512));
const Notices = Schema.Array(Notice).check(Schema.isMaxLength(32));
export const McpEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  pi: Count,
  mcp: Count,
  unsupported: Count,
  observed: Count,
  completed: Count,
  errors: Count,
  unknown: Count,
  notSent: Count,
  incomplete: Schema.Boolean,
  notices: Notices,
});
export type McpEvidence = typeof McpEvidenceSchema.Type;
export interface McpObservation {
  readonly outcome: "completed" | "unknown" | "not-sent";
  readonly isError: boolean;
  readonly incomplete: boolean;
  readonly notices: readonly string[];
}
const Origin = Schema.Struct({
  outcome: Schema.Literals(["completed", "unknown", "not-sent"]),
  isError: Schema.Boolean,
  outputValidation: Schema.optional(Schema.Literals(["passed", "failed", "unavailable"])),
});
const Metadata = Schema.Struct({
  origin: Schema.optional(Schema.Unknown),
  truncated: Schema.optional(Schema.Boolean),
  omitted: Schema.optional(Schema.Boolean),
  kind: Schema.optional(Schema.String),
  message: Schema.optional(Notice),
  result: Schema.optional(Schema.Unknown),
});
const Payload = Schema.Struct({
  truncated: Schema.optional(Schema.Boolean),
  undiscovered: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Called only after the producer envelope and bounded JSON have been validated. */
export const observeMcpReply = (reply: McpCodeModeOutput): McpObservation => {
  const notices = [...reply.notices];
  let outcome = reply.outcome;
  let isError = reply.isError;
  let incomplete = false;
  const data = reply.data === null ? {} : decodeOption(Metadata, reply.data);
  if (data === undefined) incomplete = true;
  if (reply.isError && data?.message) notices.push(data.message);
  const payload =
    data?.result === undefined
      ? data
      : Predicate.isObjectOrArray(data.result) && !Array.isArray(data.result)
        ? decodeOption(Payload, data.result)
        : {};
  if (data?.result !== undefined && payload === undefined) incomplete = true;
  if (data?.truncated || data?.omitted || data?.kind === "output-limit" || payload?.truncated)
    notices.push(
      "MCP output is truncated or omitted. Do not replay the operation to recover output.",
    );
  const discovery = decodeOption(Payload, data?.result ?? reply.data);
  if (discovery?.undiscovered?.length)
    notices.push("MCP discovery is incomplete. Select a server for a targeted list or search.");
  if (data?.kind === "cleanup")
    notices.push("MCP cleanup is unconfirmed. Reconnection is not safe recovery yet.");
  if (reply.action === "result.read" || data?.origin !== undefined) {
    const origin = decodeOption(Origin, data?.origin);
    if (origin === undefined) incomplete = true;
    else {
      if (origin.outcome === "unknown" || outcome === "unknown") outcome = "unknown";
      else if (origin.outcome === "not-sent") outcome = "not-sent";
      isError ||= origin.isError || origin.outputValidation === "failed";
      if (origin.isError || origin.outputValidation === "failed")
        notices.push(
          "The original MCP operation reported an error or failed output validation. Reading retained output does not change that outcome.",
        );
      if (origin.outputValidation === "unavailable")
        notices.push(
          "Original MCP output validation was unavailable. Do not replay the operation to recover output.",
        );
    }
  }
  if (reply.resultId !== undefined && (notices.length > 0 || isError || outcome !== "completed")) {
    if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(reply.resultId))
      notices.push(
        `Read retained MCP output with result.read id="${reply.resultId}". Reading output does not authorize replay.`,
      );
    else incomplete = true;
  }
  return { outcome, isError, incomplete, notices };
};

export const copyMcpEvidence = (evidence: McpEvidence): McpEvidence =>
  Object.freeze({ ...evidence, notices: Object.freeze([...evidence.notices]) });

/** Synchronous callbacks run within the execution fiber; no state transition spans a yield. */
export const makeMcpEvidence = () => {
  const notices: string[] = [];
  const state = {
    version: 1 as const,
    pi: 0,
    mcp: 0,
    unsupported: 0,
    observed: 0,
    completed: 0,
    errors: 0,
    unknown: 0,
    notSent: 0,
    incomplete: false,
    notices,
  };
  let closed = false;
  return {
    admit: (name: string) => {
      if (closed) return;
      if (isCompactPiTool(name)) state.pi++;
      else if (name === "mcp.request") state.mcp++;
      else state.unsupported++;
    },
    observe: (observation: McpObservation) => {
      if (closed) return;
      state.observed++;
      if (observation.outcome === "unknown") state.unknown++;
      else if (observation.outcome === "not-sent") state.notSent++;
      else state.completed++;
      if (observation.isError) state.errors++;
      state.incomplete ||= observation.incomplete;
      for (const notice of observation.notices) {
        // Never silently drop or truncate warning evidence. Sanitization redacts credentials.
        if (notice.length > 512) {
          state.incomplete = true;
          continue;
        }
        const text = sanitizeDiagnosticContent(notice, { maximumLength: Number.MAX_SAFE_INTEGER });
        if (text.length > 512) {
          state.incomplete = true;
          continue;
        }
        if (state.notices.includes(text)) continue;
        if (state.notices.length >= 32) {
          state.incomplete = true;
          continue;
        }
        state.notices.push(text);
      }
    },
    snapshot: () => copyMcpEvidence(state),
    close: () => {
      closed = true;
    },
  };
};

export const validMcpCoverage = (evidence: McpEvidence, total: number): boolean =>
  Number.isSafeInteger(total) &&
  !evidence.incomplete &&
  evidence.unsupported === 0 &&
  evidence.pi + evidence.mcp + evidence.unsupported === total &&
  evidence.observed <= evidence.mcp &&
  evidence.completed + evidence.unknown + evidence.notSent === evidence.observed &&
  evidence.errors <= evidence.observed;
