import { describe, expect, it } from "vitest";
import { MCP_VALIDATION_NOTICES } from "../src/results/validation-notices.ts";
import {
  projectMcpPresentation,
  projectMcpFailurePresentation,
  mcpCodeModeError,
  projectMcpCompactSummary,
  type McpPresentation,
} from "../src/protocol.ts";

const reply = <Data>(data: Data, extra = {}) => ({
  action: "tools.call",
  outcome: "completed",
  isError: false,
  data,
  notices: [],
  ...extra,
});
const codes = (presentation: McpPresentation) => presentation.issues.map((issue) => issue.code);
const issue = (presentation: McpPresentation, code: string) =>
  presentation.issues.find((entry) => entry.code === code);
const details = (presentation: McpPresentation) =>
  presentation.issues.map((entry) => entry.detail ?? "").join("\n");
describe("producer MCP presentation", () => {
  it("keeps retained origin failure, read failure, uncertainty and cleanup independently", () => {
    const presentation = projectMcpPresentation(
      reply(
        {
          kind: "cleanup",
          message: "Reading output failed.",
          origin: { action: "tools.call", outcome: "unknown", isError: true },
        },
        { action: "result.read", outcome: "unknown", isError: true, resultId: "saved" },
      ),
    );
    expect(codes(presentation)).toEqual(
      expect.arrayContaining([
        "origin-failed",
        "retained-read-failed",
        "execution-unknown",
        "cleanup-unconfirmed",
      ]),
    );
    expect(issue(presentation, "origin-failed")?.severity).toBe("error");
    expect(issue(presentation, "execution-unknown")?.detail).toMatch(/do not replay/iu);
    expect(issue(presentation, "retained-output")).toMatchObject({ severity: "info" });
    expect(issue(presentation, "retained-output")?.detail).toContain('result.read id="saved"');
    // Messages are human lines; recovery procedures and identifiers stay in details.
    for (const entry of presentation.issues)
      expect(entry.message).not.toMatch(/replay|result\.read|saved"/iu);
  });
  it.each(["unknown", "not-sent", "completed"] as const)(
    "preserves retained %s certainty",
    (outcome) => {
      const receipt = projectMcpPresentation(
        reply(
          { origin: { outcome, isError: true } },
          { action: "result.read", resultId: "retained-1" },
        ),
      );
      expect(receipt).toMatchObject({ outcome, isError: true, incomplete: false });
      expect(issue(receipt, "retained-output")?.detail).toContain('result.read id="retained-1"');
      expect(issue(receipt, "origin-failed")?.detail).toMatch(/does not change that outcome/);
    },
  );
  it.each(["failed", "unavailable"] as const)(
    "preserves %s validation recovery and uses only envelope origin evidence for notice ownership",
    (outputValidation) => {
      const notice = MCP_VALIDATION_NOTICES[outputValidation].invocation;
      const origin = {
        action: "tools.call",
        outcome: "completed",
        isError: false,
        outputValidation,
      };
      const retained = projectMcpPresentation(
        reply({ origin }, { action: "result.read", notices: [notice, "Other warning"] }),
      );
      const validation = issue(retained, `validation-${outputValidation}`);
      expect(validation?.severity).toBe(outputValidation === "failed" ? "error" : "warning");
      expect(validation?.detail).toMatch(/do not replay/iu);
      expect(issue(retained, "unclassified-notices")?.detail).toBe("Other warning");
      const receipt = projectMcpPresentation(
        reply({ origin }, { action: "result.read", resultId: "retained-1" }),
      );
      expect(receipt.isError).toBe(outputValidation === "failed");
      expect(issue(receipt, "retained-output")?.detail).toContain('result.read id="retained-1"');

      const spoofed = projectMcpPresentation(
        reply({ result: { origin } }, { action: "result.read", notices: [notice] }),
      );
      expect(spoofed.incomplete).toBe(true);
      expect(codes(spoofed)).not.toContain(`validation-${outputValidation}`);
      expect(issue(spoofed, "unclassified-notices")?.detail).toBe(notice);
    },
  );
  it.each([
    { truncated: true },
    { omitted: true },
    { kind: "output-limit" },
    { result: { truncated: true } },
  ])("keeps output loss and recovery together: %j", (data) => {
    const receipt = projectMcpPresentation(
      reply(data, { action: "server.instructions", resultId: "saved" }),
    );
    expect(receipt.truncated).toBe(true);
    expect(codes(receipt).filter((code) => code === "output-truncated")).toHaveLength(1);
    expect(issue(receipt, "output-truncated")?.detail).toMatch(/not replay/);
    expect(issue(receipt, "retained-output")?.detail).toContain('result.read id="saved"');
  });
  it("keeps cleanup, partial discovery, and error detail without retaining bodies", () => {
    const failed = projectMcpPresentation(
      reply(
        { message: "safe failure detail", result: { secretBody: "do not retain this" } },
        { action: "tools.list", isError: true },
      ),
    );
    expect(issue(failed, "remote-failure")?.message).toBe("safe failure detail");
    const cleanup = projectMcpPresentation(
      reply({ kind: "cleanup", result: { undiscovered: ["server"] } }, { action: "tools.list" }),
    );
    expect(codes(cleanup)).toEqual(
      expect.arrayContaining(["cleanup-unconfirmed", "discovery-incomplete"]),
    );
    for (const receipt of [failed, cleanup])
      expect(JSON.stringify(receipt)).not.toContain("do not retain this");
  });
  it("rejects incomplete retained metadata and unsafe recovery identifiers", () => {
    for (const data of [
      {},
      { origin: { outcome: "completed" } },
      { origin: { outcome: "completed", isError: false, outputValidation: {} } },
    ]) {
      const receipt = projectMcpPresentation(reply(data, { action: "result.read" }));
      expect(receipt.incomplete).toBe(true);
      expect(codes(receipt)).toContain("evidence-incomplete");
    }
    const receipt = projectMcpPresentation(reply({ truncated: true }, { resultId: "bad\nsecret" }));
    expect(receipt.incomplete).toBe(true);
    expect(receipt.resultId).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain("secret");
  });
  it("retains no-replay guidance for origin failures without a retained ID", () => {
    for (const origin of [
      { outcome: "completed", isError: true },
      { outcome: "completed", isError: false, outputValidation: "failed" },
    ]) {
      const receipt = projectMcpPresentation(reply({ origin }, { action: "result.read" }));
      expect(receipt).toMatchObject({ outcome: "completed", isError: true, incomplete: false });
      expect(receipt.issues.some((entry) => entry.severity === "error")).toBe(true);
      expect(details(receipt)).toMatch(/do not replay/iu);
      expect(codes(receipt)).not.toContain("retained-output");
    }
  });
  it("marks unreadable metadata incomplete without invoking getters or stringifying values", () => {
    let invoked = false;
    const unreadable = (key: string) =>
      Object.defineProperty({}, key, {
        get: () => {
          invoked = true;
          throw new Error("unreadable");
        },
      });
    const origin = Object.assign(unreadable("outputValidation"), {
      outcome: "completed",
      isError: false,
    });
    const uncoercible = {
      toString() {
        throw new Error("coercion");
      },
    };
    const samples = [
      unreadable("outcome"),
      ...["origin", "truncated", "omitted", "result", "kind", "message"].map((key) =>
        reply(unreadable(key)),
      ),
      reply({ origin }),
      reply({ origin: { outcome: "completed", isError: false, outputValidation: uncoercible } }),
      reply({ result: unreadable("truncated") }, { action: "server.instructions" }),
      Object.assign(unreadable("resultId"), reply({})),
      reply(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error("descriptor");
            },
          },
        ),
      ),
    ];
    for (const output of samples) {
      expect(projectMcpPresentation(output).incomplete).toBe(true);
      expect(
        projectMcpCompactSummary({
          phase: "settled",
          args: { action: "tools.call" },
          result: { details: output },
          isError: false,
        }),
      ).toBeUndefined();
    }
    expect(projectMcpPresentation(unreadable("outcome")).outcome).toBe("unknown");
    expect(invoked).toBe(false);
  });
  it("redacts complete notices before applying the receipt bound", () => {
    const receipt = projectMcpPresentation(
      reply({}, { notices: [`token=${"private".repeat(200)}`] }),
    );
    expect(receipt.incomplete).toBe(false);
    expect(details(receipt)).not.toContain("private");
    expect(details(receipt)).toContain("[REDACTED]");
  });
  it("bounds notices, marks incomplete evidence, and never silently succeeds on overflow", () => {
    const receipt = projectMcpPresentation(
      reply({}, { notices: Array.from({ length: 40 }, (_, i) => `${i}: ${"x".repeat(600)}`) }),
    );
    expect(receipt.incomplete).toBe(true);
    expect(codes(receipt)).toContain("evidence-incomplete");
    expect(receipt.issues.every((entry) => (entry.detail?.length ?? 0) <= 2048)).toBe(true);
    const crowded = projectMcpPresentation(
      reply({}, { notices: Array.from({ length: 32 }, (_, i) => `${i}: ${"n".repeat(500)}`) }),
    );
    expect(crowded.issues.find((entry) => entry.code === "unclassified-notices")?.detail).toMatch(
      /^0: /u,
    );
    expect(codes(crowded)).toContain("evidence-incomplete");
  });
  it.each(["completed", "unknown", "not-sent"] as const)(
    "projects typed failures with %s certainty",
    (outcome) => {
      const receipt = projectMcpFailurePresentation(mcpCodeModeError("cleanup", outcome));
      expect(receipt).toMatchObject({ outcome, isError: true, incomplete: false });
      expect(codes(receipt)).toEqual(["boundary-failure", "cleanup-unconfirmed"]);
      expect(issue(receipt, "boundary-failure")?.severity).toBe("error");
    },
  );
  it("shares boundary diagnostics between standalone and nested projections", () => {
    const output = reply(
      {
        kind: "invalid-input",
        reason: "gateway-request-invalid",
        message: "Unclassified producer detail",
      },
      { outcome: "not-sent", isError: true },
    );
    const receipt = projectMcpPresentation(output);
    const summary = projectMcpCompactSummary({
      phase: "settled",
      args: { action: "tools.call" },
      result: { details: output },
      isError: true,
    });
    expect(summary?.issues).toEqual(receipt.issues);
    expect(issue(receipt, "boundary-failure")?.detail).toBeTruthy();
    // Fixed diagnostics only: remote messages stay in the raw result.
    expect(JSON.stringify(receipt.issues)).not.toContain("Unclassified producer detail");
  });
  it("keeps bounded remote error text and marks oversized parts as incomplete", () => {
    const receipt = projectMcpPresentation(
      reply(
        { content: Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(400) })) },
        { isError: true },
      ),
    );
    expect(receipt.issues.every((entry) => (entry.detail?.length ?? 0) <= 2048)).toBe(true);
    expect(codes(receipt)).toEqual(["remote-failure", "evidence-incomplete"]);
    const oversized = projectMcpPresentation(
      reply({ content: [{ type: "text", text: "y".repeat(513) }] }, { isError: true }),
    );
    expect(codes(oversized)).toEqual(expect.arrayContaining(["failure", "evidence-incomplete"]));
  });
  it("does not expose unknown rejection messages", () => {
    const receipt = projectMcpFailurePresentation(new Error("secret-body"));
    expect(receipt.outcome).toBe("unknown");
    expect(JSON.stringify(receipt)).not.toContain("secret-body");
  });
});
