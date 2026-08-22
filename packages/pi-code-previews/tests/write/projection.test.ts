import { describe, expect, it } from "vitest";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";
import {
  clearWriteProjection,
  lookupBeforeWrite,
  publishWriteProjection,
  writeProjectionSize,
} from "../../src/write/projection";

describe("write projection ownership", () => {
  it("keeps a newer session visible across stale publication and cleanup", () => {
    const stale = acquireProjectionOwnership("write-stale");
    const current = acquireProjectionOwnership("write-current");
    publishWriteProjection(stale, {
      entries: [["call", { kind: "content", content: "stale" }]],
    });
    publishWriteProjection(current, {
      entries: [["call", { kind: "content", content: "current" }]],
    });

    publishWriteProjection(stale, {
      entries: [["call", { kind: "content", content: "late-stale" }]],
    });
    clearWriteProjection(stale);

    expect(lookupBeforeWrite("call")).toEqual({ kind: "content", content: "current" });
    expect(writeProjectionSize()).toBe(1);
    clearWriteProjection(current);
  });

  it("lets a newer owner replace a stale owner that never cleared", () => {
    const abandoned = acquireProjectionOwnership("write-abandoned");
    const replacement = acquireProjectionOwnership("write-replacement");
    publishWriteProjection(abandoned, {
      entries: [["old", { kind: "content", content: "old" }]],
    });
    publishWriteProjection(replacement, {
      entries: [["new", { kind: "content", content: "new" }]],
    });

    expect(lookupBeforeWrite("old")).toBeUndefined();
    expect(lookupBeforeWrite("new")).toEqual({ kind: "content", content: "new" });
    clearWriteProjection(replacement);
  });
});
