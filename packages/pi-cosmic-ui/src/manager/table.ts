import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import { padListDetailRow } from "./list-detail.ts";
import { clipToWidth } from "./chrome.ts";

interface ManagerTableColumn {
  readonly minWidth: number;
  readonly priority: number;
  /** Column heading for the table's `header` row; it widens its column but never keeps an empty one. */
  readonly header?: string | undefined;
}

const COLUMN_GAP = "  ";

/**
 * The columns with a non-empty cell, each with its natural width: the widest of its minimum, its
 * cells, and its heading.
 */
const shownColumns = <Column extends Pick<ManagerTableColumn, "minWidth" | "header">>(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<Column>,
) =>
  Arr.filterMap(columns, (column, index) => {
    const content = Math.max(0, ...Arr.map(rows, (row) => visibleWidth(row[index] ?? "")));
    const heading = visibleWidth(column.header ?? "");
    return content === 0
      ? Result.failVoid
      : Result.succeed({
          ...column,
          index,
          natural: Math.max(column.minWidth, content, heading),
        });
  });

/**
 * The width at which `managerTable` shows every cell and heading whole: each column with a
 * non-empty cell at its natural width, plus the gaps between them.
 */
export const managerTableNaturalWidth = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<Pick<ManagerTableColumn, "minWidth" | "header">>,
): number => {
  const shown = shownColumns(rows, columns);
  return (
    Arr.reduce(shown, 0, (total, column) => total + column.natural) +
    COLUMN_GAP.length * Math.max(0, shown.length - 1)
  );
};

/**
 * Lays out rows in columns that fit `width`, admitting columns by priority and growing them to
 * their natural width. A column whose cells are all empty takes no space and renders nothing.
 * When any column names a `header`, `header` is that row laid out like the others, for the caller
 * to style (muted) above them; otherwise it is `undefined`.
 */
export const managerTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<ManagerTableColumn>,
  width: number,
) => {
  const available = Math.max(0, Math.floor(width));
  const widths = Arr.map(columns, () => 0);
  // The sort is stable, so columns of equal priority keep their order.
  const priority = Arr.sortWith(
    shownColumns(rows, columns),
    (column) => column.priority,
    Order.flip(Order.Number),
  );
  let remaining = available;
  let admitted = 0;
  for (const column of priority) {
    const spacing = admitted ? COLUMN_GAP.length : 0;
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
  const row = (cells: ReadonlyArray<string>): string =>
    Arr.join(
      Arr.filterMap(columns, (_, index) =>
        widths[index] ? Result.succeed(cell(cells[index] ?? "", index)) : Result.failVoid,
      ),
      COLUMN_GAP,
    );
  const headed = Arr.some(columns, (column) => Boolean(column.header));
  return {
    widths,
    row,
    header: headed ? row(Arr.map(columns, (column) => column.header ?? "")) : undefined,
  };
};
