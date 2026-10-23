import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import { padListDetailRow } from "./list-detail.ts";
import { clipToWidth } from "./chrome.ts";

interface ManagerTableColumn {
  readonly minWidth: number;
  readonly priority: number;
}

type IndexedColumn = ManagerTableColumn & { readonly index: number };

const columnPriorityOrder = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (column: IndexedColumn) => column.priority),
  Order.mapInput(Order.Number, (column: IndexedColumn) => column.index),
);

export const managerTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<ManagerTableColumn>,
  width: number,
) => {
  const available = Math.max(0, Math.floor(width));
  const gap = "  ";
  const widths = Arr.map(columns, () => 0);
  const priority = Arr.sort(
    Arr.map(columns, (column, index) => ({
      ...column,
      index,
      natural: Math.max(column.minWidth, ...Arr.map(rows, (row) => visibleWidth(row[index] ?? ""))),
    })),
    columnPriorityOrder,
  );
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
      Arr.join(
        Arr.filterMap(columns, (_, index) =>
          widths[index] ? Result.succeed(cell(cells[index] ?? "", index)) : Result.failVoid,
        ),
        gap,
      ),
  };
};
