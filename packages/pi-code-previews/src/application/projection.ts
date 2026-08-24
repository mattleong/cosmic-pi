export interface CodePreviewSchedulerProjection {
  readonly defer: (task: () => void) => () => void;
  readonly schedule: (interval: number, task: () => void) => () => void;
}

let schedulerProjection: CodePreviewSchedulerProjection | undefined;

export function publishCodePreviewSchedulerProjection(
  projection: CodePreviewSchedulerProjection | undefined,
): void {
  schedulerProjection = projection;
}

/** Plain synchronous lifecycle projection for renderer fallback decisions. */
export function isCodePreviewSessionActive(): boolean {
  return schedulerProjection !== undefined;
}

export function deferProjectedCodePreview(task: () => void): () => void {
  return schedulerProjection?.defer(task) ?? (() => undefined);
}

export function scheduleProjectedCodePreview(interval: number, task: () => void): () => void {
  return schedulerProjection?.schedule(interval, task) ?? (() => undefined);
}
