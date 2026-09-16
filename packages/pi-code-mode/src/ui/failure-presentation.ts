/** Saved provenance must agree with the current diagnostic before details may be folded. */
import { projectFailurePresentation, type FailurePresentation } from "../tools/failure-evidence.ts";

export function verifiedFailurePresentation(
  text: string,
  saved: FailurePresentation | undefined,
): FailurePresentation | undefined {
  if (saved?.evidence.coverage !== "complete" || !text.startsWith("[ToolFailure] "))
    return undefined;
  const current = projectFailurePresentation({
    ok: false,
    error: {
      kind: "ToolFailure",
      message: text.slice("[ToolFailure] ".length),
    },
  });
  return current &&
    current.tool === saved.tool &&
    current.evidence.code === saved.evidence.code &&
    current.evidence.cause === saved.evidence.cause &&
    current.notices.length === saved.notices.length &&
    current.notices.every(
      (notice, index) =>
        notice.kind === saved.notices[index]?.kind && notice.text === saved.notices[index]?.text,
    )
    ? current
    : undefined;
}
