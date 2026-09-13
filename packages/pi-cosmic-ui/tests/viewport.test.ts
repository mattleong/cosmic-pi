import { describe, expect, it } from "vitest";
import { screenViewport } from "../src/manager/viewport.ts";
import { createScreenViewport } from "../src/boundary/host-viewport.ts";

describe("screen viewport", () => {
  it.each([
    [200, 60, 180, 54, true],
    [160, 40, 144, 36, true],
    [125, 30, 112, 27, true],
    [126, 31, 113, 27, true],
    [124, 40, 124, 40, false],
    [160, 29, 160, 29, false],
    [80, 60, 80, 60, false],
    [0, 0, 0, 0, false],
    [1, 3, 1, 3, false],
  ])("allocates %i×%i as %i×%i", (columns, rows, width, height, inset) => {
    expect(screenViewport({ columns, rows })).toEqual({ width, height, inset });
  });

  it("keeps unusable and fractional terminal dimensions bounded", () => {
    expect(screenViewport({ columns: -1, rows: Number.NaN })).toEqual({
      width: 0,
      height: 0,
      inset: false,
    });
    expect(screenViewport({ columns: Number.POSITIVE_INFINITY, rows: 24.9 })).toEqual({
      width: 0,
      height: 24,
      inset: false,
    });
    expect(screenViewport({ columns: 124.9, rows: 30 })).toEqual({
      width: 124,
      height: 30,
      inset: false,
    });
  });
});

describe("host screen viewport", () => {
  it("updates mounted overlay bounds and component height from the same live terminal", () => {
    const viewport = createScreenViewport();
    let terminal = { columns: 200, rows: 60 };
    viewport.attach(() => terminal);
    const options = viewport.overlayOptions;
    expect([options.width, options.maxHeight, options.anchor, viewport.getHeight()]).toEqual([
      180,
      54,
      "center",
      54,
    ]);
    terminal = { columns: 160, rows: 24 };
    expect([options.width, options.maxHeight, options.anchor, viewport.getHeight()]).toEqual([
      160,
      24,
      "top-left",
      24,
    ]);
    terminal = { columns: 125, rows: 30 };
    expect([options.width, options.maxHeight, options.anchor, viewport.getHeight()]).toEqual([
      112,
      27,
      "center",
      27,
    ]);
  });

  it("retains compact dialogs' original anchor on small terminals", () => {
    const viewport = createScreenViewport("bottom-center");
    const terminal = { columns: 80, rows: 24 };
    viewport.attach(() => terminal);
    expect(viewport.overlayOptions.anchor).toBe("bottom-center");
    terminal.columns = 160;
    terminal.rows = 40;
    expect(viewport.overlayOptions.anchor).toBe("center");
  });

  it("sizes separately mounted children against the terminal rather than the parent", () => {
    const terminal = { columns: 160, rows: 40 };
    const parent = createScreenViewport();
    const child = createScreenViewport();
    parent.attach(() => terminal);
    child.attach(() => terminal);
    expect(parent.getSize()).toEqual({ width: 144, height: 36, inset: true });
    expect(child.getSize()).toEqual(parent.getSize());
  });
});
