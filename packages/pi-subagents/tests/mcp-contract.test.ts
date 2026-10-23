import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MAX_SUPERVISOR_MCP_REPORT_CHARS } from "../src/supervisor/mcp-contract.ts";
import {
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  SupervisorReportTextSchema,
} from "../src/supervisor/protocol.ts";
import { decodeSupervisorToolCall } from "../src/supervisor/tool-call.ts";

const CONTACT = "agent_contact_parent";
const REPORT = "agent_submit_report";
const report = (delivery_id: string, text = "Complete.") => ({ delivery_id, report: text });

const problem = (name: string, args: Schema.Json): string => {
  const decoded = decodeSupervisorToolCall(name, args);
  if (Result.isSuccess(decoded)) throw new Error("Expected the call to be rejected.");
  return decoded.failure;
};

const decoded = (name: string, args: Schema.Json) => {
  const result = decodeSupervisorToolCall(name, args);
  return Result.isSuccess(result) ? result.success : result.failure;
};

describe("supervisor MCP arguments", () => {
  it("names the failing field without echoing the rejected value", () => {
    const delivery = problem(REPORT, report("slash/secret-value"));
    expect(delivery).toContain("delivery_id");
    expect(delivery).not.toContain("secret-value");
    expect(problem(REPORT, { delivery_id: "delivery-1" })).toContain("report");
    expect(problem(CONTACT, { kind: "progress", message: " " })).toContain("message");
    expect(problem(CONTACT, { kind: "status", message: "Halfway." })).toContain("kind");
    expect(problem(CONTACT, { message: "Halfway." })).toContain("kind");
    expect(problem(REPORT, { ...report("delivery-1"), "secret value!": 1 })).not.toContain(
      "secret value",
    );
  });

  it("names the limit a too-long argument exceeds, from the schema that rejected it", () => {
    const message = problem("agent_send", { to: "main", message: "x".repeat(131_073) });
    expect(message).toContain("message");
    expect(message).toContain("131,072");
    expect(problem(CONTACT, { kind: "progress", message: "x".repeat(65_537) })).toContain("65,536");
    expect(problem("agent_send", { to: "a".repeat(81), message: "Hi." })).toContain("80");
    const ids = Array.from({ length: 13 }, (_, index) => `agent-${index + 1}`);
    expect(problem("agent_read", { agentIds: ids })).toContain("12");
    expect(problem("agent_list", { agentIds: ids })).toContain("12");
  });

  it("explains each rejected argument shape", () => {
    for (const [name, args, field] of [
      [CONTACT, null, "kind"],
      [CONTACT, { kind: 3, message: "Halfway." }, "kind"],
      [CONTACT, { kind: "progress", message: 4 }, "message"],
      [CONTACT, { kind: "progress", message: "" }, "message"],
      [CONTACT, { kind: "progress", message: "x", extra: 1 }, "extra"],
      ["agent_send", { to: "../main", message: "Hi." }, "to"],
      ["agent_send", { message: "Hi." }, "to"],
      ["agent_list", { agentIds: "main" }, "agentIds"],
      ["agent_list", { agentIds: ["../x"] }, "agentIds"],
      ["agent_list", { verbose: true }, "verbose"],
      ["agent_read", {}, "agentIds"],
      ["agent_read", { agentIds: [] }, "agentIds"],
      ["agent_read", { agentIds: ["main"], verbose: "yes" }, "verbose"],
    ] satisfies ReadonlyArray<readonly [string, Schema.Json, string]>)
      expect(problem(name, args)).toContain(field);
  });

  it("accepts contact messages as long as a Pi child's, which the root cuts for storage", () => {
    expect(decoded(CONTACT, { kind: "warning", message: "x".repeat(65_536) })).toMatchObject({
      kind: "warning",
    });
    expect(decoded("agent_send", { to: "agent-1", message: "x".repeat(131_072) })).toMatchObject({
      kind: "agent_send",
    });
  });

  it("decodes every accepted argument shape", () => {
    expect(decoded(CONTACT, { kind: "question", message: "Ready?" })).toEqual({
      kind: "question",
      message: "Ready?",
    });
    expect(decoded(REPORT, report("delivery-1"))).toEqual({
      kind: "report",
      deliveryId: "delivery-1",
      report: "Complete.",
    });
    expect(decoded("agent_send", { to: "main", message: "Hi." })).toEqual({
      kind: "agent_send",
      to: "main",
      message: "Hi.",
    });
    expect(decoded("agent_list", {})).toEqual({ kind: "agent_list" });
    expect(decoded("agent_list", { agentIds: [] })).toEqual({ kind: "agent_list", ids: [] });
    expect(decoded("agent_read", { agentIds: ["main"], verbose: false })).toEqual({
      kind: "agent_read",
      ids: ["main"],
    });
    expect(decoded("agent_read", { agentIds: ["main"], verbose: true })).toEqual({
      kind: "agent_read",
      ids: ["main"],
      verbose: true,
    });
  });

  it("accepts a report at the cap, even behind a long blank line, and refuses a longer one", () => {
    const atCap = `${" ".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS - 1)}x`;
    expect(Result.isSuccess(decodeSupervisorToolCall(REPORT, report("delivery-1", atCap)))).toBe(
      true,
    );
    expect(Schema.decodeUnknownSync(SupervisorReportTextSchema)(atCap)).toBe(atCap);
    expect(problem(REPORT, report("delivery-1", `${atCap}y`))).toContain("report");
  });

  it("checks a blank line at the cap in linear time", () => {
    const decodes = (text: string) =>
      Result.isSuccess(decodeSupervisorToolCall(REPORT, report("delivery-1", text))) &&
      Option.isSome(Schema.decodeUnknownOption(SupervisorReportTextSchema)(text));
    const started = performance.now();
    expect(decodes(" ".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS))).toBe(false);
    expect(decodes(`${" ".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS - 2)}\nx`)).toBe(true);
    // A pattern that rescans the line from every start takes minutes here.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("fits a report at the cap in one supervisor channel line under worst-case escaping", () => {
    // Six bytes per character, with generous room for the request envelope and its IDs.
    const encoded = JSON.stringify("\u0001".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS));
    expect(new TextEncoder().encode(encoded).length + 64 * 1024).toBeLessThan(
      MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
    );
  });
});
