import { describe, expect, it } from "vitest";
import {
  isSupervisorMcpDeliveryId,
  isSupervisorMcpMessage,
  isSupervisorMcpMessageArguments,
  isSupervisorMcpReport,
  isSupervisorMcpReportArguments,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../src/supervisor/mcp-contract.ts";

describe("canonical supervisor MCP contract", () => {
  it("owns the exact registration, tool names, and snake_case argument keys", () => {
    expect(SUPERVISOR_MCP_REGISTRATION).toBe("pi_subagents_supervisor");
    expect(SUPERVISOR_MCP_MESSAGE_TOOL_NAMES).toEqual([
      "supervisor_progress",
      "supervisor_warning",
      "supervisor_question",
    ]);
    expect(SUPERVISOR_MCP_TOOL_NAMES).toEqual([
      "supervisor_progress",
      "supervisor_warning",
      "supervisor_question",
      "supervisor_submit_report",
    ]);
    expect(SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS).toEqual(["message"]);
    expect(SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS).toEqual(["delivery_id", "report"]);
    expect(SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE).toBe(".*\\S.*");
    expect(SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE).toBe("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$");
  });

  it("requires nonblank message and report text at their exact bounds", () => {
    expect(MAX_SUPERVISOR_MCP_MESSAGE_CHARS).toBe(16_384);
    expect(MAX_SUPERVISOR_MCP_REPORT_CHARS).toBe(32_768);
    expect(isSupervisorMcpMessage("x".repeat(MAX_SUPERVISOR_MCP_MESSAGE_CHARS))).toBe(true);
    expect(isSupervisorMcpMessage("x".repeat(MAX_SUPERVISOR_MCP_MESSAGE_CHARS + 1))).toBe(false);
    expect(isSupervisorMcpReport("x".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS))).toBe(true);
    expect(isSupervisorMcpReport("x".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS + 1))).toBe(false);
    for (const value of ["", " ", "\n\t"]) {
      expect(isSupervisorMcpMessage(value)).toBe(false);
      expect(isSupervisorMcpReport(value)).toBe(false);
    }
  });

  it("enforces delivery grammar and exact argument objects", () => {
    expect(MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS).toBe(256);
    expect(isSupervisorMcpDeliveryId(`a${"-".repeat(255)}`)).toBe(true);
    expect(isSupervisorMcpDeliveryId(`a${"-".repeat(256)}`)).toBe(false);
    for (const value of ["", "-first", "white space", "slash/value", "é"])
      expect(isSupervisorMcpDeliveryId(value)).toBe(false);

    expect(isSupervisorMcpMessageArguments({ message: "working" })).toBe(true);
    expect(isSupervisorMcpMessageArguments({ message: "working", unknown: true })).toBe(false);
    expect(isSupervisorMcpMessageArguments({ message: " " })).toBe(false);
    expect(isSupervisorMcpReportArguments({ delivery_id: "delivery-1", report: "Complete." })).toBe(
      true,
    );
    expect(isSupervisorMcpReportArguments({ deliveryId: "delivery-1", report: "Complete." })).toBe(
      false,
    );
    expect(
      isSupervisorMcpReportArguments({
        delivery_id: "delivery-1",
        report: "Complete.",
        unknown: true,
      }),
    ).toBe(false);
  });
});
