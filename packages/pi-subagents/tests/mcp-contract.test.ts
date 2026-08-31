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
} from "../src/supervisor/mcp-contract.ts";

describe("supervisor MCP validation", () => {
  it("accepts bounded nonblank text and rejects blank or oversized text", () => {
    expect(isSupervisorMcpMessage("working")).toBe(true);
    expect(isSupervisorMcpReport("Complete.")).toBe(true);
    expect(isSupervisorMcpMessage("x".repeat(MAX_SUPERVISOR_MCP_MESSAGE_CHARS))).toBe(true);
    expect(isSupervisorMcpMessage("x".repeat(MAX_SUPERVISOR_MCP_MESSAGE_CHARS + 1))).toBe(false);
    expect(isSupervisorMcpReport("x".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS))).toBe(true);
    expect(isSupervisorMcpReport("x".repeat(MAX_SUPERVISOR_MCP_REPORT_CHARS + 1))).toBe(false);
    for (const value of ["", " ", "\n\t"]) {
      expect(isSupervisorMcpMessage(value)).toBe(false);
      expect(isSupervisorMcpReport(value)).toBe(false);
    }
  });

  it("enforces delivery identity and strict cross-process argument objects", () => {
    expect(
      isSupervisorMcpDeliveryId(`a${"-".repeat(MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS - 1)}`),
    ).toBe(true);
    expect(isSupervisorMcpDeliveryId(`a${"-".repeat(MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS)}`)).toBe(
      false,
    );
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
