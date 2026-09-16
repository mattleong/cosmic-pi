import { describe, expect, it, vi } from "vitest";
import * as previews from "pi-code-previews";
import { describeNestedSubject, MAX_NESTED_SUBJECT_LENGTH } from "../src/tools/compact-subject.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { opaqueHostFixture } from "./support/host.ts";

describe("nested compact targets", () => {
  it.each([
    ["read", { path: "/project/src/a.ts", offset: 12, limit: 4 }, "src/a.ts:12-15"],
    ["read", { path: "a.ts", offset: 3 }, "a.ts:3"],
    ["read", { path: "a.ts" }, "a.ts"],
    ["read", { path: "/outside/a.ts" }, "/outside/a.ts"],
    ["bash", { command: "git diff --check" }, "git diff --check"],
    ["grep", { pattern: "TODO", path: "/project/src" }, "TODO in src"],
    ["find", { pattern: "*.ts" }, "*.ts in ."],
    ["grep", { pattern: "TODO" }, "TODO in ."],
    ["ls", {}, "."],
    ["write", { path: "new.ts", content: "PRIVATE BODY" }, "new.ts"],
    ["edit", { path: "old.ts", edits: [{ oldText: "PRIVATE", newText: "BODY" }] }, "old.ts"],
  ] as const)("shares standalone %s subject semantics", (tool, args, expected) => {
    const subject = describeNestedSubject(`pi.${tool}`, args, "/project");
    expect(subject).toBe(expected);
    expect(subject).toBe(previews.describeBuiltinCompactSubject(tool, args, "/project"));
  });

  it("redacts complete fields before clipping and ignores unrelated input", () => {
    const credential = "sk-" + "credential".repeat(600);
    const subject = describeNestedSubject(
      "pi.bash",
      {
        command: `curl -H 'Authorization: Bear\u001b[31mer ${credential}' https://example.test`,
        content: "PRIVATE WRITE BODY",
      },
      "/project",
    );
    expect(subject).not.toContain("credential");
    expect(subject).toContain("REDACTED");
    expect(subject).not.toContain("PRIVATE");
    expect(subject).not.toContain("\u001b");
    expect(
      describeNestedSubject("mcp.request", { arguments: { password: "PRIVATE" } }, "/project"),
    ).toBeUndefined();
    expect(describeNestedSubject("pi.powershell", { command: "Get-ChildItem" }, "/project")).toBe(
      "Get-ChildItem",
    );
  });

  it("bounds Unicode targets without splitting code points", () => {
    const subject = describeNestedSubject("pi.read", { path: "😀".repeat(4000) }, "/project")!;
    expect([...subject].length).toBeLessThanOrEqual(MAX_NESTED_SUBJECT_LENGTH);
    expect(Buffer.from(subject, "utf8").toString("utf8")).toBe(subject);
  });

  it("contains formatter failure without changing execution authority", () => {
    const formatter = vi.spyOn(previews, "describeBuiltinCompactSubject").mockImplementation(() => {
      throw new Error("path formatter failed");
    });
    try {
      expect(describeNestedSubject("pi.read", { path: "a.ts" }, "/project")).toBeUndefined();
    } finally {
      formatter.mockRestore();
    }
    const hostile = {
      get path() {
        throw new Error("getter failed");
      },
    };
    expect(describeNestedSubject("pi.read", hostile, "/project")).toBeUndefined();
  });

  it("keeps legacy and malformed subjects optional without re-resolving stored paths", () => {
    for (const subject of [undefined, {}, "x".repeat(MAX_NESTED_SUBJECT_LENGTH * 2 + 1)]) {
      const details = {
        ...callEntryDetails([{ tool: "pi.read", status: "completed" }]),
        toolCalls: [{ tool: "pi.read", status: "completed", subject }],
        outputKind: "text",
      };
      const decoded = decodeCodeModeRenderDetails(details);
      expect(decoded.compactEligible).toBe(true);
      expect(decoded.toolCalls[0]?.subject).toBeUndefined();
    }
    const details = {
      ...callEntryDetails([{ tool: "pi.read", status: "completed", subject: "src/a.ts:12-15" }]),
      outputKind: "text",
    };
    const summary = codeModeCompactSummary({
      phase: "settled",
      args: { intent: "Inspect" },
      result: { content: [], details },
      context: opaqueHostFixture({ isError: false, cwd: "/different-project" }),
    });
    expect(summary?.children?.entries[0]).toEqual({
      label: "read",
      status: "success",
      subject: "src/a.ts:12-15",
    });
    const redacted = decodeCodeModeRenderDetails({
      ...details,
      toolCalls: [{ tool: "pi.read", status: "completed", subject: "password=PRIVATE" }],
    });
    expect(redacted.toolCalls[0]?.subject).not.toContain("PRIVATE");
  });
});
