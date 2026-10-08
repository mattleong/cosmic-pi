export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const cells = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/** Outer dimensions, including the screen's own borders and footer. */
export const screenViewport = (terminal: TerminalSize) => {
  const columns = cells(terminal.columns);
  const rows = cells(terminal.rows);
  const inset = columns >= 125 && rows >= 30;
  return {
    width: inset ? Math.floor(columns * 0.9) : columns,
    height: inset ? Math.floor(rows * 0.9) : rows,
    inset,
  };
};
