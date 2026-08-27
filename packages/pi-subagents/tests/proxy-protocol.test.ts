import { describe, expect, it } from "vitest";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import {
  decodeSubagentProxyRequest,
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
