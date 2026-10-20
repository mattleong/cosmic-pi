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
