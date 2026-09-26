import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { expect } from "vitest";

/** Asserts that rendered lines fit the viewport. */
export const expectWithin = (lines: ReadonlyArray<string>, width: number, height = Infinity) => {
  expect(lines.length).toBeLessThanOrEqual(height);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
};

/** Pages down from Home, asserting that every page fits, and returns each page's joined text. */
export const pageViews = (
  component: Component,
  width: number,
  pages: number,
  { height = Infinity, join = "\n" }: { readonly height?: number; readonly join?: string } = {},
) => {
  const views: string[] = [];
  component.handleInput?.("\x1b[H");
  for (let page = 0; page < pages; page++) {
    const lines = component.render(width);
    expectWithin(lines, width, height);
    views.push(lines.join(join));
    component.handleInput?.("\x1b[6~");
  }
  return views;
};
