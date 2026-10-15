import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS as MAX_ID,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS as MAX_MESSAGE,
  MAX_SUPERVISOR_MCP_REPORT_CHARS as MAX_REPORT,
} from "../src/supervisor/mcp-contract.ts";
import { decodeSupervisorToolCall } from "../src/supervisor/tool-call.ts";

type Case = readonly [label: string, tool: string, args: Schema.Json];

const PROGRESS = "supervisor_progress";
const REPORT = "supervisor_submit_report";
const report = (delivery_id: string, text = "Complete.") => ({ delivery_id, report: text });
const idOfLength = (length: number) => `a${"-".repeat(length - 1)}`;

const problem = (name: string, args: Schema.Json): string => {
  const decoded = decodeSupervisorToolCall(name, args);
  if (Result.isSuccess(decoded)) throw new Error("Expected the call to be rejected.");
  return decoded.failure;
};

describe("supervisor MCP arguments", () => {
  it.each<Case>([
    ["a message", "supervisor_question", { message: "line one\n  line two" }],
    ["a maximal message", "supervisor_warning", { message: "x".repeat(MAX_MESSAGE) }],
    ["a maximal report", REPORT, report("delivery-1", "x".repeat(MAX_REPORT))],
    ["a maximal delivery id", REPORT, report(idOfLength(MAX_ID))],
  ])("accepts %s", (_label, name, args) => {
    expect(Result.isSuccess(decodeSupervisorToolCall(name, args))).toBe(true);
  });

  it("decodes a report's snake_case arguments into its call", () => {
    expect(decodeSupervisorToolCall(REPORT, report("delivery-1"))).toEqual(
      Result.succeed({ kind: "report", deliveryId: "delivery-1", report: "Complete." }),
    );
  });

  it.each<Case>([
    ["an oversized message", PROGRESS, { message: "x".repeat(MAX_MESSAGE + 1) }],
    ["an oversized report", REPORT, report("delivery-1", "x".repeat(MAX_REPORT + 1))],
    ["an oversized delivery id", REPORT, report(idOfLength(MAX_ID + 1))],
    ...["", " ", "\n\t"].flatMap(
      (blank): ReadonlyArray<Case> => [
        [`the blank message ${JSON.stringify(blank)}`, PROGRESS, { message: blank }],
        [`the blank report ${JSON.stringify(blank)}`, REPORT, report("delivery-1", blank)],
      ],
    ),
    ...["", "-first", "white space", "slash/value", "é"].map(
      (id): Case => [`the delivery id ${JSON.stringify(id)}`, REPORT, report(id)],
    ),
    ["an extra message key", PROGRESS, { message: "working", unknown: true }],
    ["an extra report key", REPORT, { ...report("delivery-1"), unknown: true }],
    ["a camelCase key", REPORT, { deliveryId: "delivery-1", report: "Complete." }],
    ["a non-string report", REPORT, { delivery_id: "delivery-1", report: 7 }],
    ["a bare string", PROGRESS, "working"],
    ["an unknown tool", "supervisor_unknown", { message: "working" }],
  ])("rejects %s", (_label, name, args) => {
    expect(Result.isFailure(decodeSupervisorToolCall(name, args))).toBe(true);
  });

  it("tells the child the oversized field, its length, and the limit", () => {
    const text = problem(REPORT, report("delivery-1", "x".repeat(MAX_REPORT + 5)));
    expect(text).toContain("report");
    expect(text).toContain((MAX_REPORT + 5).toLocaleString("en-US"));
    expect(text).toContain(MAX_REPORT.toLocaleString("en-US"));
    expect(text).not.toContain("xxxx");
  });

  it("names the failing field without echoing the rejected value", () => {
    const delivery = problem(REPORT, report("slash/secret-value"));
    expect(delivery).toContain("delivery_id");
    expect(delivery).not.toContain("secret-value");
    expect(problem(REPORT, { delivery_id: "delivery-1" })).toContain("report");
    expect(problem(PROGRESS, { message: " " })).toContain("message");
    expect(problem(REPORT, { ...report("delivery-1"), "secret value!": 1 })).not.toContain(
      "secret value",
    );
  });
});
