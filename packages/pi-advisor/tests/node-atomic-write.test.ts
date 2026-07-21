// Node boundary fault-injection harness.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const faults = vi.hoisted(() => ({
  destination: "",
  temporary: "",
  destinationChmods: 0,
  postCommitCleanups: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (path: Parameters<typeof actual.chmodSync>[0], mode: number) => {
      if (String(path) === faults.destination) {
        faults.destinationChmods++;
        throw new Error("injected destination chmod failure");
      }
      return actual.chmodSync(path, mode);
    },
    rmSync: (
      path: Parameters<typeof actual.rmSync>[0],
      options?: Parameters<typeof actual.rmSync>[1],
    ) => {
      if (String(path) === faults.temporary && faults.destination) {
        faults.postCommitCleanups++;
        throw new Error("injected post-commit cleanup failure");
      }
      return actual.rmSync(path, options as never);
    },
  };
});

import { writeTextFileAtomicSync } from "../src/boundary/node.ts";

const roots: string[] = [];

afterEach(() => {
  faults.destination = "";
  faults.temporary = "";
  faults.destinationChmods = 0;
  faults.postCommitCleanups = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-advisor-atomic-write-"));
  roots.push(root);
  return root;
}

describe("writeTextFileAtomicSync", () => {
  test("never removes a colliding temporary file it did not acquire", () => {
    const path = join(makeRoot(), "settings.json");
    vi.spyOn(Date, "now").mockReturnValue(123);
    const temporary = `${path}.${process.pid}.123.tmp`;
    writeFileSync(temporary, "owned elsewhere", { mode: 0o600 });

    expect(() => writeTextFileAtomicSync(path, "replacement")).toThrow();
    expect(readFileSync(temporary, "utf8")).toBe("owned elsewhere");
  });

  test("finishes permissions before rename and performs no fallible post-commit cleanup", () => {
    const path = join(makeRoot(), "settings.json");
    vi.spyOn(Date, "now").mockReturnValue(456);
    faults.destination = path;
    faults.temporary = `${path}.${process.pid}.456.tmp`;

    expect(() => writeTextFileAtomicSync(path, "committed")).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("committed");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(faults.destinationChmods).toBe(0);
    expect(faults.postCommitCleanups).toBe(0);
  });
});
