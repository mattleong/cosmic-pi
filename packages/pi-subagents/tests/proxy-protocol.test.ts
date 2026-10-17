import { describe, expect, it } from "vitest";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/run/limits.ts";
import {
  decodeSubagentProxyRequest,
  decodeSubagentProxyResult,
  decodeSubagentProxyParent,
  encodeSubagentProxyInput,
  withSubagentProxyParent,
} from "../src/tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";
import { listContract, modelsContract, renameContract } from "../src/tools/discovery-contract.ts";
import { profileCandidate } from "./fixtures/profiles.ts";
import { view } from "./fixtures/run-view.ts";

const request = (count: number) => ({
  tool: "subagent_start",
  argumentsJson: JSON.stringify({
    agents: Array.from({ length: count }, (_, index) => ({ task: `Task ${index + 1}` })),
  }),
});

describe("nested Pi proxy protocol", () => {
  const parentContext = {
    sessionId: "child-session",
    sessionFile: "/sessions/child.jsonl",
    leafId: "child-findings",
    model: "openai/child-model",
    effort: "medium" as const,
    contextTokens: 123,
  };

  it("keeps bridge parent facts separate from public launch arguments", () => {
    const input: SubagentToolInput = {
      tool: "subagent_start",
      args: { agents: [{ task: "Inspect the package", profile: "scout" }] },
    };
    const encoded = encodeSubagentProxyInput(input);
    const envelope = withSubagentProxyParent(encoded, parentContext);
    expect(decodeSubagentProxyRequest(envelope)).toBeInstanceOf(InvalidSubagentRequestError);
    const decoded = decodeSubagentProxyParent(envelope);
    expect(decoded).toEqual({ request: encoded, parentContext });
    if (decoded instanceof InvalidSubagentRequestError) throw decoded;
    expect(decodeSubagentProxyRequest(decoded.request)).toEqual(input);
    expect(decodeSubagentProxyParent(encoded)).toEqual({ request: encoded });
  });

  it.each([
    { callerRunId: "root" },
    { projectTrusted: true },
    { activeTools: ["write"] },
    { sessionFile: "/sessions/injected\nfile.jsonl" },
  ])("rejects malformed parent facts and caller authority %j", (override) => {
    expect(
      decodeSubagentProxyParent({
        tool: "subagent_start",
        argumentsJson: JSON.stringify({
          parentContext: { ...parentContext, ...override },
          argumentsJson: JSON.stringify({ agents: [{ task: "Inspect" }] }),
        }),
      }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it("does not admit parent facts as public start-item fields", () => {
    expect(
      decodeSubagentProxyRequest({
        tool: "subagent_start",
        argumentsJson: JSON.stringify({ agents: [{ task: "Inspect", parentContext }] }),
      }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it("round-trips discovery and rename contracts while rejecting report-text injection", () => {
    const run = view({
      id: "a",
      state: "completed",
      finalText: "PRIVATE-REPORT",
      reportStatus: "available",
    });
    const contracts = [
      listContract(Array.from({ length: 64 }, (_, index) => ({ ...run, id: `run-${index}` }))),
      modelsContract(
        [
          {
            id: "scout",
            description: "Inspect code",
            source: "builtin",
            isDefault: false,
            defaultContext: "fresh",
            defaultWriteIntent: "read-only",
            candidates: [
              {
                ...profileCandidate(),
                status: "eligible",
                reason: "Static adapter eligibility only",
              },
            ],
          },
        ],
        "generalist",
      ),
      renameContract({ runId: "a", run }),
      renameContract({
        runId: "missing",
        failure: { id: "missing", code: "rename_outcome_uncertain", message: "Outcome unknown" },
      }),
    ];
    for (const structuredContent of contracts) {
      const result = {
        content: [{ type: "text", text: "Existing human output" }],
        details: { unchanged: true },
        structuredContent,
        ...(structuredContent.tool === "subagent_rename" &&
          structuredContent.outcome === "failed" && { isError: true }),
      };
      expect(decodeSubagentProxyResult(JSON.stringify(result))).toEqual(result);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-REPORT");
    }
    const list = listContract([run]);
    expect(
      decodeSubagentProxyResult(
        JSON.stringify({
          content: [],
          details: {},
          structuredContent: {
            ...list,
            runs: [{ ...list.runs[0], report: { status: "delivered", text: "PRIVATE-REPORT" } }],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it.each([
    { action: "list", callerRunId: "root" },
    { action: "discard", workspaceId: "w", ownerId: "root" },
    { action: "integrate", workspaceId: "w", revisionId: "r", preparationId: "p", approved: true },
  ])("rejects invalid or forged workspace arguments %j", (args) => {
    expect(
      decodeSubagentProxyRequest({
        tool: "subagent_workspace",
        argumentsJson: JSON.stringify(args),
      }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });
  it.each([
    {
      label: "accepts the text bound",
      source: JSON.stringify({
        content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT_CHARS) }],
      }),
      accepted: true,
      expectedDetails: {},
    },
    {
      label: "rejects text beyond the bound",
      source: JSON.stringify({
        content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1) }],
      }),
      accepted: false,
    },
  ])("$label", ({ source, accepted, expectedDetails }) => {
    const decoded = decodeSubagentProxyResult(source);
    expect(decoded !== undefined).toBe(accepted);
    if (accepted) expect(decoded?.details).toEqual(expectedDetails);
  });

  it("accepts the hard 32-item start bound and rejects a larger batch", () => {
    expect(decodeSubagentProxyRequest(request(32))).not.toBeInstanceOf(InvalidSubagentRequestError);
    expect(decodeSubagentProxyRequest(request(33))).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it.each([
    ["spoofed ancestry", "subagent_start", { agents: [{ task: "spoof", parentRunId: "sibling" }] }],
  ])("rejects %s", (_label, tool, args) => {
    expect(decodeSubagentProxyRequest({ tool, argumentsJson: JSON.stringify(args) })).toMatchObject(
      {
        code: "proxy_request_invalid",
      },
    );
  });

  it.each(["ask_user", "__proto__"])("rejects the unknown coordinator tool %s", (tool) => {
    const decoded = decodeSubagentProxyRequest({ tool, argumentsJson: "{}" });
    expect(decoded).toBeInstanceOf(InvalidSubagentRequestError);
    expect(decoded).toMatchObject({
      code: "proxy_request_invalid",
    });
  });
});
