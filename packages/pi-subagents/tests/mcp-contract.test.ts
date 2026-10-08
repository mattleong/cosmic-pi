import { describe, expect, it } from "vitest";
import {
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS as MAX_ID,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS as MAX_MESSAGE,
  MAX_SUPERVISOR_MCP_REPORT_CHARS as MAX_REPORT,
} from "../src/supervisor/mcp-contract.ts";
import { decodeSupervisorToolCall } from "../src/supervisor/tool-call.ts";

type Case = readonly [label: string, tool: string, args: unknown];

const PROGRESS = "supervisor_progress";
const REPORT = "supervisor_submit_report";
const report = (delivery_id: string, text = "Complete.") => ({ delivery_id, report: text });
const idOfLength = (length: number) => `a${"-".repeat(length - 1)}`;

describe("supervisor MCP arguments", () => {
  it.each<Case>([
    ["a message", "supervisor_question", { message: "line one\n  line two" }],
    ["a maximal message", "supervisor_warning", { message: "x".repeat(MAX_MESSAGE) }],
    ["a maximal report", REPORT, report("delivery-1", "x".repeat(MAX_REPORT))],
    ["a maximal delivery id", REPORT, report(idOfLength(MAX_ID))],
  ])("accepts %s", (_label, name, args) => {
    expect(decodeSupervisorToolCall(name, args)).toBeDefined();
  });

  it("decodes a report's snake_case arguments into its call", () => {
    expect(decodeSupervisorToolCall(REPORT, report("delivery-1"))).toEqual({
      kind: "report",
      deliveryId: "delivery-1",
      report: "Complete.",
    });
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
    ["a bare string", PROGRESS, "working"],
    ["an unknown tool", "supervisor_unknown", { message: "working" }],
  ])("rejects %s", (_label, name, args) => {
    expect(decodeSupervisorToolCall(name, args)).toBeUndefined();
  });
});
