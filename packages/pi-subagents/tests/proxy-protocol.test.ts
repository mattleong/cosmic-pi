import { describe, expect, it } from "vitest";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/run/limits.ts";
import { SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";
import {
  decodeSubagentProxyRequest,
  decodeSubagentProxyResult,
  encodeSubagentProxyInput,
} from "../src/tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";

const proxyRoundTripCases = [
  {
    label: "models",
    tool: "subagent_models",
    input: { action: "models", profile: "reviewer" },
  },
  {
    label: "start",
    tool: "subagent_start",
    input: {
      action: "start",
      agents: [{ task: "Inspect the package", profile: "scout" }],
    },
  },
  { label: "list", tool: "subagent_list", input: { action: "list" } },
  {
    label: "status",
    tool: "subagent_status",
    input: { action: "status", runIds: ["agent-1"] },
  },
  {
    label: "await",
    tool: "subagent_await",
    input: { action: "await", runIds: ["agent-1"], until: "all_finished" },
  },
  {
    label: "send",
    tool: "subagent_send",
    input: { action: "send", runIds: ["agent-1"], message: "Continue." },
  },
  {
    label: "reply",
    tool: "subagent_reply",
    input: { action: "reply", runId: "agent-1", message: "Use the fixture." },
  },
  {
    label: "lifecycle",
    tool: "subagent_lifecycle",
    input: { action: "resume", runIds: ["agent-1"], message: "Continue carefully." },
  },
  {
    label: "rename",
    tool: "subagent_rename",
    input: { action: "rename", runId: "agent-1", name: "reviewer" },
  },
  {
    label: "claims",
    tool: "subagent_claims",
    input: {
      action: "claims",
      operation: { action: "grant", runId: "agent-1", paths: ["src/fixture.ts"] },
    },
  },
  {
    label: "workspace",
    tool: "subagent_workspace",
    input: {
      action: "workspace",
      operation: {
        action: "integrate",
        workspaceId: "workspace-1",
        revisionId: "revision-1",
        preparationId: "prepared-1",
      },
    },
  },
] satisfies ReadonlyArray<{
  readonly label: string;
  readonly tool: string;
  readonly input: SubagentToolInput;
}>;

describe("nested Pi proxy protocol", () => {
  it.each([
    { action: "integrate", workspaceId: "w", revisionId: "r" },
    { action: "review", workspaceId: "w", offset: 1 },
    { action: "review", workspaceId: "w", limit: 16_001 },
    { action: "review", workspaceId: "w", offset: -1 },
    { action: "list", callerRunId: "root" },
    { action: "discard", workspaceId: "w", ownerId: "root" },
    { action: "review", workspaceId: "w", processCleanupConfirmed: true },
    {
      action: "prepare",
      workspaceId: "w",
      revisionId: "r",
      writerWorkspaceMode: "shared-checkout",
    },
    { action: "integrate", workspaceId: "w", revisionId: "r", preparationId: "p", approved: true },
    { action: "revise", workspaceId: "w", message: " " },
  ])("rejects invalid or forged workspace arguments %j", (args) => {
    expect(
      decodeSubagentProxyRequest({
        tool: "subagent_workspace",
        argumentsJson: JSON.stringify(args),
      }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });
  it("keeps the named map frozen and the ordered tuple stable", () => {
    expect(Object.isFrozen(SUBAGENT_TOOL_NAME)).toBe(true);
    expect(SUBAGENT_TOOL_NAMES).toEqual(proxyRoundTripCases.map(({ tool }) => tool));
  });

  it.each(proxyRoundTripCases)("round-trips $label inputs", ({ input, tool }) => {
    const encoded = encodeSubagentProxyInput(input);
    expect(encoded.tool).toBe(tool);
    if (input.action === "start") expect(encoded.argumentsJson).not.toContain("parentRunId");
    expect(decodeSubagentProxyRequest(encoded)).toEqual(input);
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

  it.each([
    ["malformed JSON", "{not-json"],
    ["a valid primitive JSON value", "42"],
    ["a valid array JSON value", "[]"],
  ])("rejects %s before tool execution", (_label, argumentsJson) => {
    expect(decodeSubagentProxyRequest({ tool: "subagent_list", argumentsJson })).toBeInstanceOf(
      InvalidSubagentRequestError,
    );
  });

  it("accepts the 2 MiB JSON bound and rejects one character more", () => {
    const maximum = 2 * 1024 * 1024;
    const bounded = `{${" ".repeat(maximum - 2)}}`;
    expect(decodeSubagentProxyRequest({ tool: "subagent_list", argumentsJson: bounded })).toEqual({
      action: "list",
    });
    expect(
      decodeSubagentProxyRequest({ tool: "subagent_list", argumentsJson: `${bounded} ` }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
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

  it("rejects spoofed ancestry, excess fields, and unknown tools", () => {
    for (const request of [
      {
        tool: "subagent_start",
        argumentsJson: JSON.stringify({
          agents: [{ task: "spoof", parentRunId: "sibling" }],
        }),
      },
      { tool: "subagent_list", argumentsJson: JSON.stringify({ extra: true }) },
      { tool: "subagent_unknown", argumentsJson: "{}" },
    ])
      expect(decodeSubagentProxyRequest(request)).toBeInstanceOf(InvalidSubagentRequestError);
  });
});
