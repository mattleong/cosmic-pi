import { describe, expect, it } from "vitest";
import { isProjectTrusted } from "../src/host-session.ts";

describe("project trust capture", () => {
  it("requires an explicit callback returning literal true", () => {
    expect(isProjectTrusted({})).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: true })).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: () => 1 })).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: () => true })).toBe(true);
  });

  it("fails closed when the host callback throws", () => {
    expect(
      isProjectTrusted({
        isProjectTrusted() {
          throw new Error("host failure");
        },
      }),
    ).toBe(false);
  });
});
