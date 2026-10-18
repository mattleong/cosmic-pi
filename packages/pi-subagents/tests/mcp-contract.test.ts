import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
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
});
