import { describe, expect, it } from "@effect/vitest";
import { allocateRuntimeNamespace, identityAllocators } from "../../src/run/identity.ts";

describe("run identity", () => {
  it("never repeats a runtime's run IDs within one process", () => {
    const ids = new Set<string>();
    for (let runtime = 0; runtime < 20_000; runtime++)
      ids.add(
        identityAllocators(allocateRuntimeNamespace()).allocateRunIdentity("", () => false).id,
      );
    expect(ids.size).toBe(20_000);
  });

  it("mints random run IDs around taken ones and numbers only default names", () => {
    const { allocateRunIdentity } = identityAllocators(allocateRuntimeNamespace());
    const first = allocateRunIdentity("", () => false);
    const rejected: string[] = [];
    const second = allocateRunIdentity("named", (id) => {
      if (rejected.length > 0) return false;
      rejected.push(id);
      return true;
    });
    for (const { id } of [first, second]) expect(id).toMatch(/^agent-[0-9a-z]{10}$/u);
    expect(second.id).not.toBe(rejected[0]);
    expect([first.name, second.name, allocateRunIdentity("", () => false).name]).toEqual([
      "subagent-1",
      "named",
      "subagent-3",
    ]);
  });
});
