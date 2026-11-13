import { describe, expect, it } from "vitest";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";
import {
  clearWriteProjection,
  lookupBeforeWrite,
  publishWriteProjection,
} from "../../src/write/projection";

describe("write projection ownership", () => {
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
