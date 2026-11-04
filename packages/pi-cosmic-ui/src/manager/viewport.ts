export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const cells = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/**
 * Screen surfaces cover the whole terminal. Pi composites an overlay over the transcript without
 * clearing what lies beside it, so any inset would leave clipped transcript fragments around the
 * frame and could draw over the footer.
 */
export const screenViewport = (terminal: TerminalSize) => ({
  width: cells(terminal.columns),
  height: cells(terminal.rows),
});
