import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { padListDetailRow } from "./list-detail.ts";
import { clipToWidth } from "./chrome.ts";

interface ManagerTableColumn {
  readonly minWidth: number;
  readonly priority: number;
}

export const managerTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<ManagerTableColumn>,
  width: number,
) => {
  const available = Math.max(0, Math.floor(width));
  const gap = "  ";
  const widths = columns.map(() => 0);
  const priority = columns
    .map((column, index) => ({
      ...column,
      index,
      natural: Math.max(column.minWidth, ...rows.map((row) => visibleWidth(row[index] ?? ""))),
    }))
    .toSorted((a, b) => b.priority - a.priority || a.index - b.index);
  let remaining = available;
  let admitted = 0;
  for (const column of priority) {
    const spacing = admitted ? gap.length : 0;
    const minimum = Math.min(column.natural, Math.max(1, column.minWidth));
    if (remaining - spacing < minimum && admitted) continue;
    const size = Math.max(0, Math.min(minimum, remaining - spacing));
    if (!size) continue;
    widths[column.index] = size;
    remaining -= size + spacing;
    admitted += 1;
  }
  for (const column of priority) {
    const admittedWidth = widths[column.index] ?? 0;
    if (!admittedWidth) continue;
    const extra = Math.min(remaining, column.natural - admittedWidth);
    widths[column.index] = admittedWidth + extra;
    remaining -= extra;
  }
  const cell = (text: string, column: number): string =>
    padListDetailRow(clipToWidth(text, widths[column] ?? 0), widths[column] ?? 0);
  return {
    widths,
    row: (cells: ReadonlyArray<string>): string =>
      Arr.filterMap(columns, (_, index) =>
        widths[index] ? Result.succeed(cell(cells[index] ?? "", index)) : Result.failVoid,
      ).join(gap),
  };
};
