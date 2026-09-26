import { describe, expect, it } from "vitest";
import type { CompactIssue } from "pi-code-previews";
import { CompactAttentionSchema, CompactReceiptSchema } from "../src/tools/compact-evidence.ts";
import { decodeOption } from "../src/tools/format.ts";
import { BoundedIssuesSchema, retainIssues } from "../src/tools/issue-evidence.ts";
import { COMPLETE_LEDGER } from "./support/compact.ts";

const issue = (patch: Partial<CompactIssue> = {}): CompactIssue => ({
  severity: "error",
  code: "remote-failure",
  message: "Element detached",
  detail: "Do not replay to recover output.",
  ...patch,
});

describe("bounded issue evidence", () => {
  it("redacts and clips retained text instead of rejecting the receipt, reporting cut details", () => {
    const source = [
      issue({
        code: "",
        message: `token=secret-value \u001b[31m${"m".repeat(400)}`,
        detail: `password=hunter2\n${"d".repeat(3000)}`,
      }),
      issue({ severity: "info", detail: "" }),
    ];
    const before = JSON.stringify(source);
    const { issues, dropped } = retainIssues(source);
    // A detail cut short loses recovery text, so the evidence is reported incomplete.
    expect(dropped).toBe(true);
    expect(decodeOption(BoundedIssuesSchema, issues)).toBeDefined();
    expect(issues[0]!.code.length).toBeGreaterThan(0);
    expect(issues[0]!.message.length).toBeLessThanOrEqual(240);
    expect(issues[0]!.detail!.length).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(issues)).not.toMatch(/secret-value|hunter2|\\u001b/u);
    expect(issues[1]).not.toHaveProperty("detail");
    expect(JSON.stringify(source)).toBe(before);
    // Producer details up to 2048 characters survive whole.
    const whole = retainIssues([issue({ detail: "d".repeat(2000) })]);
    expect(whole.dropped).toBe(false);
    expect(whole.issues[0]?.detail).toHaveLength(2000);
  });

  it("keeps the first entries within the bound and reports dropped issues", () => {
    const many = Array.from({ length: 17 }, (_, index) => issue({ message: `Issue ${index}` }));
    const retained = retainIssues(many);
    expect(retained.dropped).toBe(true);
    expect(retained.issues.map((entry) => entry.message)).toEqual(
      many.slice(0, 16).map((entry) => entry.message),
    );
    expect(retainIssues(many.slice(0, 16)).dropped).toBe(false);
    expect(retainIssues(undefined)).toEqual({ issues: [], dropped: false });
  });

  it("decodes only current, bounded receipts and ledgers", () => {
    const receipt = {
      version: 3,
      subject: "file",
      outcome: "success",
      issues: [issue()],
      deliveryFailed: false,
    };
    expect(decodeOption(CompactReceiptSchema, receipt)).toBeDefined();
    for (const invalid of [
      { ...receipt, version: 2 },
      {
        ...receipt,
        version: 2,
        issues: { coverage: "complete", entries: [] },
        notices: [{ kind: "recovery", text: "Old recovery" }],
      },
      { ...receipt, outcome: "hostile" },
      { ...receipt, subject: "x".repeat(1025) },
      { ...receipt, issues: Array.from({ length: 17 }, () => issue()) },
      { ...receipt, issues: [issue({ message: "m".repeat(241) })] },
      { ...receipt, issues: [issue({ code: "" })] },
      { ...receipt, deliveryFailed: "no" },
    ])
      expect(decodeOption(CompactReceiptSchema, invalid)).toBeUndefined();

    expect(decodeOption(CompactAttentionSchema, COMPLETE_LEDGER)).toEqual(COMPLETE_LEDGER);
    for (const invalid of [
      {
        ...COMPLETE_LEDGER,
        version: 2,
        admitted: 0,
        started: 0,
        observed: 0,
        unsupported: 0,
        notices: [],
        issues: { coverage: "complete", entries: [] },
      },
      { ...COMPLETE_LEDGER, errors: -1 },
      { ...COMPLETE_LEDGER, warnings: 1.5 },
      { ...COMPLETE_LEDGER, incomplete: "no" },
    ])
      expect(decodeOption(CompactAttentionSchema, invalid)).toBeUndefined();
  });
});
