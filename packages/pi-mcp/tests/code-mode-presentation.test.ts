import { describe, expect, it } from "vitest";
import {
  projectMcpPresentation,
  projectMcpFailurePresentation,
  mcpCodeModeError,
  projectMcpCompactSummary,
} from "../src/protocol.ts";

const reply = <Data>(data: Data, extra = {}) => ({
  action: "tools.call",
  outcome: "completed",
  isError: false,
  data,
  notices: [],
  ...extra,
});
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
    expect(presentation.issues.coverage).toBe("unknown");
    expect(presentation.issues.entries.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "origin-failed",
        "retained-read-failed",
        "execution-unknown",
        "cleanup-unconfirmed",
      ]),
    );
    expect(
      presentation.issues.entries.flatMap((entry) => entry.recovery).map((entry) => entry.code),
    ).toEqual(expect.arrayContaining(["inspect-before-replay", "cleanup-gate", "read-retained"]));
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
      expect(receipt.notices.join(" ")).toContain('result.read id="retained-1"');
      expect(receipt.notices.join(" ")).toMatch(/does not change that outcome/);
    },
  );
  it.each(["failed", "unavailable"])("preserves %s validation and recovery", (outputValidation) => {
    const receipt = projectMcpPresentation(
      reply(
        {
          origin: { action: "tools.call", outcome: "completed", isError: false, outputValidation },
        },
        { action: "result.read", resultId: "retained-1" },
      ),
    );
    expect(receipt.isError).toBe(outputValidation === "failed");
    expect(receipt.notices.join(" ")).toMatch(/validation/);
    expect(receipt.notices.join(" ")).toContain('result.read id="retained-1"');
  });
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
    expect(
      receipt.notices.filter((notice) => notice.includes("truncated or omitted")),
    ).toHaveLength(1);
    expect(receipt.notices.join(" ")).toContain('result.read id="saved"');
    expect(receipt.notices.join(" ")).toMatch(/not replay/);
  });
  it("keeps cleanup, partial discovery, and error detail without retaining bodies", () => {
    const receipt = projectMcpPresentation(
      reply(
        {
          kind: "cleanup",
          message: "safe failure detail",
          result: { undiscovered: ["server"], secretBody: "do not retain this" },
        },
        { action: "tools.list", isError: true },
      ),
    );
    expect(receipt.notices.join(" ")).toMatch(/cleanup is unconfirmed/);
    expect(receipt.notices.join(" ")).toMatch(/Discovery is incomplete/);
    expect(receipt.notices).toContain("safe failure detail");
    expect(JSON.stringify(receipt)).not.toContain("do not retain this");
  });
  it("rejects incomplete retained metadata and unsafe recovery identifiers", () => {
    for (const data of [
      {},
      { origin: { outcome: "completed" } },
      { origin: { outcome: "completed", isError: false, outputValidation: {} } },
    ]) {
      expect(projectMcpPresentation(reply(data, { action: "result.read" })).incomplete).toBe(true);
    }
    const receipt = projectMcpPresentation(reply({ truncated: true }, { resultId: "bad\nsecret" }));
    expect(receipt.incomplete).toBe(true);
    expect(receipt.resultId).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain("secret");
  });
  it("does not invoke metadata accessors or stringify unknown values", () => {
    const hostile = {
      get outcome() {
        throw new Error("getter");
      },
      toString() {
        throw new Error("coercion");
      },
    };
    expect(projectMcpPresentation(hostile)).toMatchObject({ outcome: "unknown", incomplete: true });
    expect(
      projectMcpPresentation(
        reply({ origin: { outcome: "completed", isError: false, outputValidation: hostile } }),
      ).incomplete,
    ).toBe(true);
  });
  it("retains no-replay guidance for origin failures without a retained ID", () => {
    for (const origin of [
      { outcome: "completed", isError: true },
      { outcome: "completed", isError: false, outputValidation: "failed" },
    ]) {
      const receipt = projectMcpPresentation(reply({ origin }, { action: "result.read" }));
      expect(receipt).toMatchObject({ outcome: "completed", isError: true, incomplete: false });
      expect(receipt.notices.join(" ")).toMatch(/do not replay/iu);
    }
  });
  it("marks unreadable optional metadata incomplete without invoking getters", () => {
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
    const samples = [
      ...["origin", "truncated", "omitted", "result", "kind", "message"].map((key) =>
        reply(unreadable(key)),
      ),
      reply({ origin }),
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
    expect(invoked).toBe(false);
  });
  it("redacts complete notices before applying the receipt bound", () => {
    const receipt = projectMcpPresentation(
      reply({}, { notices: [`token=${"private".repeat(200)}`] }),
    );
    expect(receipt.notices.join(" ")).not.toContain("private");
    expect(receipt.notices.join(" ")).toContain("[REDACTED]");
  });
  it("bounds warnings and marks incomplete evidence", () => {
    const receipt = projectMcpPresentation(
      reply({}, { notices: Array.from({ length: 40 }, (_, i) => `${i}: ${"x".repeat(600)}`) }),
    );
    expect(receipt.incomplete).toBe(true);
    expect(receipt.notices.length).toBeLessThanOrEqual(32);
    expect(receipt.notices.every((notice) => notice.length <= 512)).toBe(true);
  });
  it.each(["completed", "unknown", "not-sent"] as const)(
    "projects typed failures with %s certainty",
    (outcome) => {
      const receipt = projectMcpFailurePresentation(mcpCodeModeError("cleanup", outcome));
      expect(receipt).toMatchObject({ outcome, isError: true, incomplete: false });
      expect(receipt.notices.join(" ")).toMatch(/cleanup is unconfirmed/);
    },
  );
  it("shares boundary diagnostics between standalone and nested projections without renderer ownership", () => {
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
    expect(receipt.issues.entries[0]?.diagnostics?.length).toBeGreaterThan(0);
    expect(receipt.notices.join(" ")).toContain("Unclassified producer detail");
    expect(JSON.stringify(receipt.issues)).not.toContain("expandedInResult");
    expect(JSON.stringify(receipt.issues)).not.toContain("ownedIssues");
  });
  it("does not authorize complete coverage when combined remote evidence exceeds bounds", () => {
    const receipt = projectMcpPresentation(
      reply(
        { content: Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(400) })) },
        { isError: true },
      ),
    );
    expect(receipt.issues.coverage).toBe("unknown");
    expect(receipt.issues.entries.every((issue) => issue.cause.length <= 2048)).toBe(true);
    expect(receipt.issues.entries.some((issue) => issue.code === "evidence-incomplete")).toBe(true);
  });
  it("does not expose unknown rejection messages", () => {
    const receipt = projectMcpFailurePresentation(new Error("secret-body"));
    expect(receipt.outcome).toBe("unknown");
    expect(JSON.stringify(receipt)).not.toContain("secret-body");
  });
});
