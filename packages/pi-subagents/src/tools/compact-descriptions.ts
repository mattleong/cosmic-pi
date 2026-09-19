/** Human-facing facts keyed by producer-owned notice identities, never raw messages. */
export function runNoticeDescription(
  code: string | undefined,
  kind: "warning" | "error" | "recovery",
): string {
  if (code?.startsWith("selection:")) return "A configured worker option was skipped.";
  const descriptions = new Map(
    Object.entries({
      "containment-audit": "A file-access violation was detected.",
      "containment-wait": "The worker has not yet confirmed that it paused or stopped.",
      "peer-admission-paused": "New writing is paused while a file-access issue is resolved.",
      "paused-recovery": "The worker is paused.",
      "parent-question": "The worker needs a reply.",
      "question-unavailable": "The worker needs a reply, but its question is unavailable.",
      "run-failed": "The worker failed.",
      "cleanup-pending": "The worker is stopping. Cleanup is not yet confirmed.",
      "stopped-cleanup": "The worker stopped; its cleanup status needs confirmation.",
      "workspace-approval": "The proposed changes have not been approved for integration.",
      "evidence-omitted": "Some worker details are unavailable in this view.",
      "write-audit": "File-access violations were recorded.",
      "targets-omitted": "Some requested workers have no available status.",
      "await-timeout": "Timed out waiting. Unfinished workers continue running.",
      "parent-action": "A worker needs attention before it can continue.",
      "runs-omitted": "Only some workers are shown.",
      "launch-recovery-unknown": "Worker ownership and cleanup status are unknown.",
    }),
  );
  return (
    descriptions.get(code ?? "") ??
    (kind === "error"
      ? "The worker reported an error."
      : kind === "warning"
        ? "The worker reported a warning."
        : "")
  );
}
