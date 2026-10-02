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
    "Workflow descendants can only launch read-only agents\n\nThe root main agent can authorize separate writer work outside this workflow tree.",
  );
