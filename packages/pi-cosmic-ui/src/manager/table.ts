import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padListDetailRow } from "./list-detail.ts";

export interface ManagerTableColumn {
  /** Minimum useful width. Lower-priority columns disappear first when it cannot fit. */
  readonly minWidth: number;
  /** Higher values reserve space first; declaration order remains the display order. */
  readonly priority: number;
  readonly maxWidth?: number;
}

/** Measure the complete dataset, not its visible window. Styling stays caller-owned. */
export const managerTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<ManagerTableColumn>,
  width: number,
) => {
  const available = Math.max(0, Math.floor(width));
  const gap = "  ";
  const natural = columns.map((column, index) =>
    Math.min(
      column.maxWidth ?? Infinity,
      Math.max(column.minWidth, ...rows.map((row) => visibleWidth(row[index] ?? ""))),
    ),
  );
  const widths = columns.map(() => 0);
  const priority = columns
    .map((column, index) => ({ ...column, index }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  let remaining = available;
  let admitted = 0;
  for (const column of priority) {
    const spacing = admitted ? gap.length : 0;
    const minimum = Math.min(natural[column.index]!, Math.max(1, column.minWidth));
    if (remaining - spacing < minimum && admitted) continue;
    const size = Math.max(0, Math.min(minimum, remaining - spacing));
    if (!size) continue;
    widths[column.index] = size;
    remaining -= size + spacing;
    admitted += 1;
  }
  for (const column of priority) {
    if (!widths[column.index]) continue;
    const extra = Math.min(remaining, natural[column.index]! - widths[column.index]!);
    widths[column.index]! += extra;
    remaining -= extra;
  }
  return {
    widths,
    cell: (text: string, column: number): string =>
      padListDetailRow(truncateToWidth(text, widths[column] ?? 0), widths[column] ?? 0),
    row: (cells: ReadonlyArray<string>): string =>
      columns
        .flatMap((_, index) =>
          widths[index]
            ? [
                padListDetailRow(
                  truncateToWidth(cells[index] ?? "", widths[index]!),
                  widths[index]!,
                ),
              ]
            : [],
        )
        .join(gap),
  };
};
