let sessionActive = false;
let deferTask: ((task: () => void) => () => void) | undefined;
let scheduleTask: ((interval: number, task: () => void) => () => void) | undefined;

/** Plain synchronous lifecycle projection for renderer fallback decisions. */
export function publishCodePreviewSessionActive(active: boolean): void {
  sessionActive = active;
}

export function isCodePreviewSessionActive(): boolean {
  return sessionActive;
}

export function publishCodePreviewDefer(
  defer: ((task: () => void) => () => void) | undefined,
): void {
  deferTask = defer;
}

export function deferProjectedCodePreview(task: () => void): () => void {
  return deferTask?.(task) ?? (() => undefined);
}

export function publishCodePreviewSchedule(
  schedule: ((interval: number, task: () => void) => () => void) | undefined,
): void {
  scheduleTask = schedule;
}

export function scheduleProjectedCodePreview(interval: number, task: () => void): () => void {
  return scheduleTask?.(interval, task) ?? (() => undefined);
}
