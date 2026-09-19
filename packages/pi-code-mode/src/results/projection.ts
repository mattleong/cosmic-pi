import { utf8ByteLength } from "../tools/limits.ts";
import { resultReadFailure, type ResultReadProjection } from "./read-presentation.ts";
import type { ResultArtifact, ResultPage } from "./model.ts";

const boundary = (text: string, offset: number) =>
  offset > 0 &&
  offset < text.length &&
  /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
  /[\uDC00-\uDFFF]/.test(text[offset]!)
    ? offset - 1
    : offset;

/** UTF-16 offsets; only publish a next cursor when at least one full code point fits. */
export function projectResultPage(
  artifact: ResultArtifact,
  offset: number,
  limit: number,
  maxBytes: number,
): ResultReadProjection {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > artifact.text.length ||
    boundary(artifact.text, offset) !== offset
  ) {
    return resultReadFailure("invalid-offset", maxBytes);
  }
  const start = offset;
  const end = boundary(artifact.text, Math.min(artifact.text.length, start + limit));
  const render = (finish: number) =>
    JSON.stringify({
      id: artifact.id,
      outcome: artifact.outcome,
      kind: artifact.kind,
      offset: start,
      next: finish < artifact.text.length ? finish : null,
      total: artifact.text.length,
      text: artifact.text.slice(start, finish),
    } satisfies ResultPage);
  const project = (finish: number, text: string): ResultReadProjection => ({
    text,
    presentation: {
      status: "page",
      id: artifact.id,
      originalOutcome: artifact.outcome,
      offset: start,
      end: finish,
      next: finish < artifact.text.length ? finish : null,
      total: artifact.text.length,
    },
  });
  // EOF replaces a numeric cursor with null and can shrink metadata. Test that endpoint
  // before the monotone search over nonterminal prefixes.
  const whole = render(end);
  if ((end > start || start === artifact.text.length) && utf8ByteLength(whole) <= maxBytes)
    return project(end, whole);
  let low = start;
  let high = end;
  let best = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const finish = boundary(artifact.text, middle);
    if (utf8ByteLength(render(finish)) <= maxBytes) {
      best = finish;
      low = middle + 1;
    } else high = middle - 1;
  }
  if ((best === start && start < artifact.text.length) || utf8ByteLength(render(best)) > maxBytes) {
    return resultReadFailure("page-budget", maxBytes);
  }
  return project(best, render(best));
}
