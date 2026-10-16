import { sessionReportArchive } from "../../src/boundary/report-archive.ts";
import { allocateRuntimeNamespace, identityAllocators } from "../../src/run/identity.ts";

/** A new process allocates the same first public run id when the Pi session resumes. */
export const archiveReport = (agentDirectory: string, text: string) => {
  const { allocateRunIdentity } = identityAllocators(allocateRuntimeNamespace());
  const { id } = allocateRunIdentity("reader");
  const report = sessionReportArchive(
    agentDirectory,
    "resumed-session",
  )({
    id,
    generation: 1,
    text,
  });
  if (!report) throw new Error("Archive process fixture could not write its report.");
  return { id, path: report.path };
};
