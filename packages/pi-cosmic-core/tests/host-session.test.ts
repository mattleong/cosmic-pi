import { describe, expect, it } from "vitest";
import { isProjectTrusted, notifyAtHostBoundary } from "../src/host-session.ts";

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

describe("notification boundary", () => {
  it("contains hostile thenable inspection", () => {
    const hostileThenable = new Proxy(
      {},
      {
        has: (_target, property) => property === "then",
        get: (_target, property) => {
          if (property === "then") throw new Error("hostile then getter");
          return undefined;
        },
      },
    );

    expect(() =>
      notifyAtHostBoundary({ ui: { notify: () => hostileThenable } }, "message", "warning"),
    ).not.toThrow();
  });

  it("attaches a rejection handler to callable thenables", () => {
    let rejectionContained = false;
    const callableThenable = new Proxy(() => undefined, {
      has: (_target, property) => property === "then",
      get: (_target, property) =>
        property === "then"
          ? (_resolve: () => void, reject: (reason: Error) => void) => {
              reject(new Error("rejected callable thenable"));
              rejectionContained = true;
            }
          : undefined,
    });

    notifyAtHostBoundary({ ui: { notify: () => callableThenable } }, "message", "warning");

    expect(rejectionContained).toBe(true);
  });
});
