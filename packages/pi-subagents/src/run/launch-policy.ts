import type { RunRecord } from "./internal.ts";
import type { StartSubagentRequest } from "./model.ts";
import { invalidRequest, withGuidance } from "./errors.ts";

export const scriptOriginForStart = (
  records: ReadonlyMap<string, RunRecord>,
  request: StartSubagentRequest,
  scriptedRoot: boolean,
): boolean =>
  scriptedRoot ||
  (request.parentRunId !== undefined && records.get(request.parentRunId)?.scriptOrigin === true);

export const scriptedWriterAdmissionError = () =>
  invalidRequest(
    "scripted_subtree_writer_not_supported",
    withGuidance(
      "Agents started by a codemode script can only launch read-only agents",
      "The main agent can start separate writer work outside this script's agents.",
      "\n\n",
    ),
  );
