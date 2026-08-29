import { describe, expect, it } from "vitest";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/run/limits.ts";
import {
  decodeSubagentProxyRequest,
  decodeSubagentProxyResult,
  encodeSubagentProxyInput,
} from "../src/tools/proxy-protocol.ts";

describe("nested Pi proxy protocol", () => {
  it("round-trips strict public tool inputs without ancestry fields", () => {
    const encoded = encodeSubagentProxyInput({
      action: "start",
      agents: [{ task: "Inspect the package", profile: "scout" }],
    });
    expect(encoded.tool).toBe("subagent_start");
    expect(encoded.argumentsJson).not.toContain("parentRunId");
    expect(decodeSubagentProxyRequest(encoded)).toEqual({
      action: "start",
      agents: [{ task: "Inspect the package", profile: "scout" }],
    });
  });

  it.each([
    {
      label: "defaults missing details",
      source: '{"content":[{"type":"text","text":"ok"}]}',
      accepted: true,
      expectedDetails: {},
    },
    {
      label: "preserves explicit details",
      source: '{"content":[],"details":{"revision":1}}',
      accepted: true,
      expectedDetails: { revision: 1 },
    },
    {
      label: "accepts 64 content entries",
      source: JSON.stringify({
        content: Array.from({ length: 64 }, () => ({ type: "text", text: "ok" })),
      }),
      accepted: true,
      expectedDetails: {},
    },
    {
      label: "accepts the text bound",
      source: JSON.stringify({
        content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT_CHARS) }],
      }),
      accepted: true,
      expectedDetails: {},
    },
    { label: "rejects malformed JSON", source: "{not-json", accepted: false },
    {
      label: "rejects 65 content entries",
      source: JSON.stringify({
        content: Array.from({ length: 65 }, () => ({ type: "text", text: "ok" })),
      }),
      accepted: false,
    },
    {
      label: "rejects text beyond the bound",
      source: JSON.stringify({
        content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1) }],
      }),
      accepted: false,
    },
    {
      label: "rejects root excess properties",
      source: '{"content":[],"extra":true}',
      accepted: false,
    },
    {
      label: "rejects content excess properties",
      source: '{"content":[{"type":"text","text":"ok","extra":true}]}',
      accepted: false,
    },
  ])("$label", ({ source, accepted, expectedDetails }) => {
    const decoded = decodeSubagentProxyResult(source);
    expect(decoded !== undefined).toBe(accepted);
    if (accepted) expect(decoded?.details).toEqual(expectedDetails);
  });

  it("accepts the hard 32-item start bound and rejects a larger batch", () => {
    const request = (count: number) => ({
      tool: "subagent_start",
      argumentsJson: JSON.stringify({
        agents: Array.from({ length: count }, (_, index) => ({ task: `Task ${index + 1}` })),
      }),
    });
    expect(decodeSubagentProxyRequest(request(32))).not.toBeInstanceOf(InvalidSubagentRequestError);
    expect(decodeSubagentProxyRequest(request(33))).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it("rejects spoofed ancestry, excess fields, malformed JSON, and unknown tools", () => {
    for (const request of [
      {
        tool: "subagent_start",
        argumentsJson: JSON.stringify({
          agents: [{ task: "spoof", parentRunId: "sibling" }],
        }),
      },
      { tool: "subagent_list", argumentsJson: JSON.stringify({ extra: true }) },
      { tool: "subagent_list", argumentsJson: "{not-json" },
      { tool: "subagent_unknown", argumentsJson: "{}" },
    ])
      expect(decodeSubagentProxyRequest(request)).toBeInstanceOf(InvalidSubagentRequestError);
  });
});
