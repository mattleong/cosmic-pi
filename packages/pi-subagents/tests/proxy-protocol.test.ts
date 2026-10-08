import { describe, expect, it } from "vitest";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/run/limits.ts";
import {
  decodeSubagentProxyRequest,
  decodeSubagentProxyResult,
  encodeSubagentProxyInput,
} from "../src/tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";
import { startContract } from "../src/tools/contract.ts";
import { view } from "./fixtures/run-view.ts";

const proxyRoundTripCases: ReadonlyArray<SubagentToolInput> = [
  { tool: "subagent_models", args: { profile: "reviewer" } },
  {
    tool: "subagent_start",
    args: { agents: [{ task: "Inspect the package", profile: "scout" }] },
  },
  { tool: "subagent_list", args: {} },
  { tool: "subagent_status", args: { runIds: ["agent-1"] } },
  { tool: "subagent_await", args: { runIds: ["agent-1"], until: "all_finished" } },
  { tool: "subagent_send", args: { runIds: ["agent-1"], message: "Continue." } },
  { tool: "subagent_reply", args: { runId: "agent-1", message: "Use the fixture." } },
  {
    tool: "subagent_lifecycle",
    args: { action: "resume", runIds: ["agent-1"], message: "Continue carefully." },
  },
  { tool: "subagent_rename", args: { runId: "agent-1", name: "reviewer" } },
  {
    tool: "subagent_claims",
    args: { action: "grant", runId: "agent-1", paths: ["src/fixture.ts"] },
  },
  {
    tool: "subagent_workspace",
    args: {
      action: "integrate",
      workspaceId: "workspace-1",
      revisionId: "revision-1",
      preparationId: "prepared-1",
    },
  },
];

describe("nested Pi proxy protocol", () => {
  it("round-trips machine-readable outcomes without losing partial failure evidence", () => {
    const contract = startContract(
      [{ task: "Inspect" }, { task: "Unavailable" }],
      [
        { index: 0, run: view({ id: "started" }) },
        {
          index: 1,
          failure: { index: 1, code: "start_outcome_uncertain", message: "Launch is unconfirmed." },
        },
      ],
    );
    const result = {
      content: [{ type: "text", text: "Launch receipt" }],
      details: {},
      structuredContent: contract,
      isError: true,
    };
    expect(decodeSubagentProxyResult(JSON.stringify(result))).toEqual(result);
    expect(
      decodeSubagentProxyResult(
        JSON.stringify({ ...result, structuredContent: { ...contract, extra: true } }),
      ),
    ).toBeUndefined();
    expect(
      decodeSubagentProxyResult(
        JSON.stringify({ ...result, structuredContent: { ...contract, version: 2 } }),
      ),
    ).toBeUndefined();
  });

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
  it.each(proxyRoundTripCases)("round-trips $tool inputs", (input) => {
    const encoded = encodeSubagentProxyInput(input);
    expect(encoded).toEqual({ tool: input.tool, argumentsJson: JSON.stringify(input.args) });
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
      tool: "subagent_list",
      args: {},
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

  it.each([
    ["spoofed ancestry", "subagent_start", { agents: [{ task: "spoof", parentRunId: "sibling" }] }],
    ["excess fields", "subagent_list", { extra: true }],
    ["a retry message", "subagent_lifecycle", { action: "retry", runIds: ["a"], message: "m" }],
    [
      "an interrupt message",
      "subagent_lifecycle",
      { action: "interrupt", runIds: ["a"], message: "m" },
    ],
    ["a claims operation error", "subagent_claims", { action: "grant", runId: "agent-1" }],
  ])("rejects %s", (_label, tool, args) => {
    expect(decodeSubagentProxyRequest({ tool, argumentsJson: JSON.stringify(args) })).toMatchObject(
      {
        code: "proxy_request_invalid",
      },
    );
  });

  it.each(["subagent_unknown", "ask_user", "constructor", "__proto__", "toString"])(
    "rejects the unknown coordinator tool %s",
    (tool) => {
      const decoded = decodeSubagentProxyRequest({ tool, argumentsJson: "{}" });
      expect(decoded).toBeInstanceOf(InvalidSubagentRequestError);
      expect(decoded).toMatchObject({
        code: "proxy_request_invalid",
      });
    },
  );
});
