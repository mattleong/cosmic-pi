import { describe, expect, it } from "@effect/vitest";
import { allocateRuntimeNamespace, identityAllocators } from "../../src/run/identity.ts";

describe("run identity", () => {
  it("never repeats a runtime's run IDs within one process", () => {
    const ids = new Set<string>();
    for (let runtime = 0; runtime < 20_000; runtime++)
      ids.add(identityAllocators(allocateRuntimeNamespace()).allocateRunIdentity("").id);
    expect(ids.size).toBe(20_000);
  });
});
