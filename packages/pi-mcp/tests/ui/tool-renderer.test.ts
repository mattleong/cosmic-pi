import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { boundaryError } from "../../src/client/errors.ts";
import { mcpDiagnostic } from "../../src/client/diagnostics.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";
import { normalizeResult, prefixBytes } from "../../src/results/normalize.ts";
import { MCP_VALIDATION_NOTICES } from "../../src/results/validation-notices.ts";
import { projectPrepared } from "../../src/results/projection.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  decodeMcpCardDetails,
  MCP_CARD_LIMITS,
  mcpCallSummary,
} from "../../src/ui/tool-render-details.ts";
import { renderMcpCall, renderMcpResult } from "../../src/ui/tool-renderer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const reply = (data = {}) => ({
  details: { action: "tools.call", outcome: "completed", isError: false, notices: [], data },
  content: [],
});
const display = <Result>(result: Result, expanded = false, isPartial = false) =>
  renderMcpResult(result, { expanded, isPartial }, theme, "configured-key to expand")
    .render(80)
    .join("\n");

describe("MCP card projections", () => {
  it("preserves auth recovery and discovery context when reconstructing historical error cards", () => {
    const error = boundaryError("auth-required", "unknown", "private-token", "auth-not-configured");
    const details = mcpFailureReply("tools.search", error);
    const card = decodeMcpCardDetails({ details, content: [] });
    expect(card.outcome).toBe("unknown");
    expect(card.isError).toBe(true);
    expect(card.diagnostic).toEqual(mcpDiagnostic(error, { action: "tools.search" }));
    expect(card.diagnostic?.recovery).toEqual(["inspect-operation"]);
    expect(card.warnings.join(" ")).toMatch(/Do not replay/);
    expect(JSON.stringify(card)).not.toContain("private-token");
    const legacy = decodeMcpCardDetails({
      details: { ...details, data: { kind: "auth-required" } },
      content: [],
    });
    expect(legacy.diagnostic?.explanation).not.toContain("no managed authentication configured");
    expect(legacy.diagnostic?.recovery).toEqual(["inspect-operation"]);
  });
  it.effect("projects actual discovery pages and normalized attachment descriptors", () =>
    Effect.gen(function* () {
      const normalized = normalizeResult({
        owner: "owner",
        server: "docs",
        action: "tools.list",
        reply: {
          outcome: "completed",
          result: {
            page: {
              items: [{ name: "one" }, { name: "two" }],
              total: 7,
              nextCursor: "opaque-next-cursor",
            },
            undiscovered: ["other"],
          },
        },
      });
      const discovery = yield* projectPrepared(
        {
          ...normalized,
          owner: "owner",
          server: "docs",
          activation: {},
          generation: 0,
          serverGeneration: 0,
        },
        { status: "retained", resultId: "retained-1" },
        { maxOutputBytes: 51_200, images: false },
      );
      const card = { details: discovery.reply, content: [] };
      const projection = decodeMcpCardDetails(card);
      expect(projection.page).toEqual({ returned: 2, total: 7, hasMore: true });
      expect(projection.undiscoveredCount).toBe(1);
      for (const count of projection.counts)
        expect(display(card).replace(/\s+/g, " ")).toContain(count);
      expect(display(card)).not.toContain("opaque-next-cursor");

      const binary = normalizeResult({
        owner: "owner",
        server: "docs",
        action: "tools.call",
        reply: {
          outcome: "completed",
          result: {
            content: [
              { type: "image", mimeType: "image/png", data: "invalid" },
              { type: "text", text: "existing text" },
            ],
          },
        },
      });
      const projected = yield* projectPrepared(
        {
          ...binary,
          owner: "owner",
          server: "docs",
          activation: {},
          generation: 0,
          serverGeneration: 0,
        },
        { status: "retained", resultId: "retained-2" },
        { maxOutputBytes: 51_200, images: false },
      );
      expect(decodeMcpCardDetails({ details: projected.reply })).toMatchObject({
        attachmentCount: 1,
        imageCount: 0,
        attachmentsLimited: false,
      });
    }),
  );

  it("preserves benign connection and remote state while redacting auth-specific fields", () => {
    const result = reply({
      result: {
        servers: [{ state: "connected", auth: "unchecked" }],
        state: "remote-state-value",
        oauthState: "PRIVATE-STATE",
        authorizationUrl: "PRIVATE-URL",
        accessToken: "PRIVATE-TOKEN",
      },
    });
    const projection = decodeMcpCardDetails(result);
    expect(projection.preview).toContain("connected");
    expect(projection.preview).toContain("unchecked");
    expect(projection.preview).toContain("remote-state-value");
    expect(projection.preview).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).toContain("PRIVATE-TOKEN");
  });

  it("reports per-string display cuts without claiming source truncation or failure", () => {
    const result = reply({ result: { content: [{ type: "text", text: "x".repeat(2001) }] } });
    const retained = { ...result, details: { ...result.details, resultId: "retained-text" } };
    const before = JSON.stringify(retained);
    const projection = decodeMcpCardDetails(retained);
    expect(projection.displayCuts).toContain("strings");
    expect(projection.preview.length).toBeLessThan(MCP_CARD_LIMITS.text);
    expect(projection.truncated).toBe(false);
    expect(projection.isError).toBe(false);
    expect(projection.outcome).toBe("completed");
    expect(projection.warnings).toEqual([]);
    expect(display(retained, false)).not.toContain("retained-text");
    expect(display(retained, true)).toContain("retained-text");
    expect(projection.recoveryHint).toContain("retained-text");
    expect(JSON.stringify(retained)).toBe(before);
  });

  it("keeps readable multiline content and raw metadata together in expanded cards", () => {
    const text = "first line\n  indented second\n\nlast line";
    const result = reply({
      result: {
        content: [
          { type: "text", text },
          { type: "attachment", index: 0 },
        ],
        metadata: "raw-metadata",
      },
    });
    const projection = decodeMcpCardDetails(result);
    expect(projection.preview).toContain(text);
    expect(projection.preview).toContain("raw-metadata");
    expect(projection.preview).toContain("attachment");
    expect(display(result, true)).toContain("first line");
    expect(display(result, true)).toContain("raw-metadata");
    expect(projection.displayCuts).toEqual([]);
  });

  it("keeps unknown, cleanup and truncation warnings available without expansion", () => {
    const result = {
      ...reply({ kind: "cleanup", truncated: true }),
      details: {
        ...reply().details,
        outcome: "unknown",
        isError: true,
        data: { kind: "cleanup", truncated: true },
        notices: ["Output was not retained and is not recoverable by result ID."],
      },
    };
    const projection = decodeMcpCardDetails(result);
    expect(projection.outcome).toBe("unknown");
    expect(projection.truncated).toBe(true);
    expect(projection.warnings).toHaveLength(4);
    const collapsed = display(result).replace(/\s+/g, " ");
    for (const warning of projection.warnings) expect(collapsed).toContain(warning);
    expect(collapsed).not.toMatch(/retry/i);
  });

  it.each(["completed", "unknown"] as const)(
    "preserves original %s failure when retrieving a successful retained page",
    (outcome) => {
      const result = {
        details: {
          ...reply().details,
          action: "result.read",
          resultId: "retained-1",
          data: {
            origin: {
              action: "tools.call",
              outcome,
              isError: true,
              outputValidation: "failed",
            },
            text: "existing output",
            next: 19,
            truncated: true,
          },
        },
        content: [],
      };
      const before = JSON.stringify(result);
      const projection = decodeMcpCardDetails(result);
      expect(projection.isError).toBe(false);
      expect(projection.origin).toMatchObject({
        outcome,
        isError: true,
        outputValidationFailed: true,
      });
      for (const warning of projection.warnings)
        expect(display(result).replace(/\s+/g, " ")).toContain(warning);
      expect(projection.resultId).toBe("retained-1");
      expect(projection.recoveryHint).toContain("/mcp result retained-1");
      expect(display(result)).toMatch(/original.*validation failed/i);
      expect(display(result, true)).toContain("existing output");
      expect(JSON.stringify(result)).toBe(before);
    },
  );

  it("discloses unavailable validation without claiming an output mismatch", () => {
    const result = {
      details: {
        ...reply().details,
        action: "result.read",
        resultId: "retained-1",
        data: {
          origin: {
            action: "tools.call",
            outcome: "completed",
            isError: false,
            outputValidation: "unavailable",
          },
          text: "existing output",
        },
      },
      content: [],
    };
    const projection = decodeMcpCardDetails(result);
    expect(projection.isError).toBe(false);
    expect(projection.origin).toMatchObject({
      outcome: "completed",
      isError: false,
      outputValidationFailed: false,
      outputValidationUnavailable: true,
    });
    expect(projection.warnings.length).toBeGreaterThan(0);
    for (const warning of projection.warnings)
      expect(display(result).replace(/\s+/g, " ")).toContain(warning);
    expect(display(result)).not.toMatch(/validation failed/i);
    expect(projection.recoveryHint).toContain("/mcp result retained-1");
    expect(display(result, true)).toContain("existing output");
  });

  it.each(["failed", "unavailable"] as const)(
    "consolidates exact owned %s notices without changing the result",
    (outputValidation) => {
      const producerNotices = Object.values(MCP_VALIDATION_NOTICES[outputValidation]);
      const notices = producerNotices.flatMap((text) => [text, prefixBytes(text, 128)]);
      const result = {
        details: {
          ...reply().details,
          action: "result.read",
          resultId: "retained-1",
          notices,
          data: {
            origin: {
              action: "tools.call",
              outcome: "completed",
              isError: false,
              outputValidation,
            },
            text: "retained output",
          },
        },
        content: [],
      };
      const before = JSON.stringify(result);
      const card = decodeMcpCardDetails(result);
      expect(card.notices).toEqual([]);
      expect(card.warnings).toHaveLength(1);
      expect(card.warnings[0]).toContain("Do not replay the operation to recover its output.");
      expect(card.warnings[0]).toContain(
        outputValidation === "failed" ? "captured schema" : "No mismatch was established",
      );
      const expanded = display(result, true).replace(/\s+/g, " ");
      expect(expanded.split(card.warnings[0]!).length - 1).toBe(1);
      expect(expanded.split("/mcp result retained-1").length - 1).toBe(1);
      expect(JSON.stringify(result)).toBe(before);
    },
  );

  it("preserves near-matches, opposite states and remote prose", () => {
    const original = MCP_VALIDATION_NOTICES.failed.normalization;
    const notices = [
      original + " Extra context.",
      " " + original,
      MCP_VALIDATION_NOTICES.unavailable.invocation,
      "unrelated notice",
    ];
    const result = {
      details: {
        ...reply().details,
        isError: true,
        notices: [original, ...notices],
        data: {
          origin: {
            action: "tools.call",
            outcome: "completed",
            isError: false,
            outputValidation: "failed",
          },
          result: { notices: [original] },
        },
      },
      content: [],
    };
    const before = JSON.stringify(result);
    const card = decodeMcpCardDetails(result);
    // Existing terminal sanitization trims whitespace, but must not suppress this near-match.
    expect(card.notices).toEqual(notices.map((notice) => notice.trim()));
    expect(card.preview).toContain(original);
    expect(card.warnings.some((warning) => warning.includes("captured schema"))).toBe(true);
    expect(JSON.stringify(result)).toBe(before);
  });

  it.each([
    { action: "tools.list" },
    { outcome: "unknown" },
    { isError: undefined },
    { isError: true },
    { outputValidation: "passed" },
    { outputValidation: "unknown" },
  ])("preserves producer notices for contradictory or missing origin evidence: %j", (override) => {
    const notices = Object.values(MCP_VALIDATION_NOTICES.failed);
    const card = decodeMcpCardDetails({
      details: {
        ...reply().details,
        isError: true,
        notices,
        data: {
          origin: {
            action: "tools.call",
            outcome: "completed",
            isError: false,
            outputValidation: "failed",
            ...override,
          },
        },
      },
    });
    expect(card.notices).toEqual(notices);
    if ("isError" in override && override.isError === true)
      expect(
        card.warnings.some((warning) => warning.includes("original operation reported a failure")),
      ).toBe(true);
  });

  it("reports counts and images without copying or touching image bytes", () => {
    const image = {
      type: "image",
      get data() {
        throw new Error("must not read image");
      },
    };
    const result = {
      ...reply({
        result: { tools: [{ name: "one" }, { name: "two" }], attachments: [{ kind: "image" }] },
      }),
      content: [image],
    };
    const projection = decodeMcpCardDetails(result);
    expect(projection.counts).toContain("2 tools");
    expect(projection.attachmentCount).toBe(1);
    expect(projection.imageCount).toBe(1);
    expect(() => display(result, true)).not.toThrow();
  });

  it("reads a bounded legacy JSON envelope but does not invent certainty for partial or missing details", () => {
    const legacy = { content: [{ type: "text", text: JSON.stringify(reply().details) }] };
    expect(decodeMcpCardDetails(legacy)).toMatchObject({ known: true, outcome: "completed" });
    for (const value of [
      null,
      [],
      7,
      { details: { action: "connect" } },
      { content: [{ type: "text", text: "legacy non-JSON" }] },
    ]) {
      expect(decodeMcpCardDetails(value).known).toBe(false);
      expect(decodeMcpCardDetails(value).outcome).toBeUndefined();
      expect(() => display(value, true)).not.toThrow();
    }
    expect(display(reply(), false, true)).toMatch(/progress/i);
    expect(display(reply(), false, true)).not.toMatch(/completed|not sent/i);
    expect(display({ details: { isError: true } })).toMatch(/failed/i);
  });

  it("contains getters, cycles, revoked proxies and hostile terminal controls with bounded output", () => {
    let getters = 0;
    const data = {
      text: "safe\x1b]52;c;PRIVATE-CLIPBOARD\x07\x1b[2J visible",
      get secret() {
        getters++;
        throw new Error("SECRET");
      },
      toJSON: () => {
        throw new Error("must not serialize source");
      },
    };
    Object.defineProperty(data, "cycle", { value: data, enumerable: true });
    const result = reply(data);
    const text = display(result, true);
    expect(getters).toBe(0);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("PRIVATE-CLIPBOARD");
    expect(text).toContain("visible");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => display(revoked.proxy, true)).not.toThrow();
    expect(() => display(reply(revoked.proxy), true)).not.toThrow();
    const huge = reply({ rows: Array.from({ length: 1000 }, () => "x".repeat(100_000)) });
    const projection = decodeMcpCardDetails(huge);
    expect(projection.preview.length).toBeLessThan(MCP_CARD_LIMITS.text + 100);
    expect(projection.preview.split("\n").length).toBeLessThanOrEqual(MCP_CARD_LIMITS.lines + 1);
    expect(
      decodeMcpCardDetails({ details: { ...reply().details, resultId: "bad\n/mcp auth server" } })
        .resultId,
    ).toBeUndefined();
    for (const width of [1, 12, 40]) {
      const lines = renderMcpResult(result, { expanded: true, isPartial: false }, theme).render(
        width,
      );
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("keeps target identity separate from display and never inspects argument values", () => {
    const args = {
      action: "tools.call",
      server: "docs\x1b[2J",
      tool: "lookup",
      get arguments() {
        throw new Error("not presentation input");
      },
    };
    expect(mcpCallSummary(args)).toEqual({ action: "tools.call", target: "docs / lookup" });
    expect(renderMcpCall(args, theme).render(40).join(" ")).toContain("lookup");
    expect(mcpCallSummary({})).toEqual({ action: "status", target: "" });
    expect(args.server).toContain("\x1b");
  });
});
