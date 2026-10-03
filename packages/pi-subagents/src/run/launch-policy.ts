import type { RunRecord } from "./internal.ts";
import type { StartSubagentRequest } from "./model.ts";
import { invalidRequest } from "./errors.ts";

/** Caller holds the registry lock. Provenance is internal, never taken from request arguments. */
export const scriptOriginForStart = (
  records: ReadonlyMap<string, RunRecord>,
  request: StartSubagentRequest,
  scriptedRoot: boolean,
): boolean =>
  scriptedRoot ||
  (request.parentRunId !== undefined && records.get(request.parentRunId)?.scriptOrigin === true) ||
  (request.supersedes !== undefined &&
    records.get(request.supersedes.runId)?.scriptOrigin === true);

export const scriptedWriterAdmissionError = () =>
  invalidRequest(
    "scripted_subtree_writer_not_supported",
    "Agents started by a codemode script can only launch read-only agents\n\nThe main agent can start separate writer work outside this script's agents.",
  );
