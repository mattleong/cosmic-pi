import * as Fn from "effect/Function";
import * as Result from "effect/Result";
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
import { cancelledAwaitContract, lifecycleContract } from "../src/tools/contract.ts";
import { modelsContract } from "../src/tools/discovery-contract.ts";
import { profileCandidate } from "./fixtures/profiles.ts";
import { view } from "./fixtures/run-view.ts";
import { rejection } from "./support/result.ts";
import * as Str from "effect/String";

const request = (count: number) => ({
  tool: "agent_start",
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
      tool: "agent_start",
      args: { agents: [{ task: "Inspect the package", profile: "scout" }] },
    };
    const encoded = encodeSubagentProxyInput(input);
    const envelope = withSubagentProxyParent(encoded, parentContext);
    expect(rejection(decodeSubagentProxyRequest(envelope))).toBeInstanceOf(
      InvalidSubagentRequestError,
    );
    const decoded = Result.getOrThrow(decodeSubagentProxyParent(envelope));
    expect(decoded).toEqual({ request: encoded, parentContext });
    expect(Result.getOrUndefined(decodeSubagentProxyRequest(decoded.request))).toEqual(input);
    expect(Result.getOrUndefined(decodeSubagentProxyParent(encoded))).toEqual({ request: encoded });
  });

  it.each([
    { callerRunId: "root" },
    { projectTrusted: true },
    { activeTools: ["write"] },
    { sessionFile: "/sessions/injected\nfile.jsonl" },
  ])("rejects malformed parent facts and caller authority %j", (override) => {
    expect(
      rejection(
        decodeSubagentProxyParent({
          tool: "agent_start",
          argumentsJson: JSON.stringify({
            parentContext: { ...parentContext, ...override },
            argumentsJson: JSON.stringify({ agents: [{ task: "Inspect" }] }),
          }),
        }),
      ),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it("does not admit parent facts as public start-item fields", () => {
    expect(
      rejection(
        decodeSubagentProxyRequest({
          tool: "agent_start",
          argumentsJson: JSON.stringify({ agents: [{ task: "Inspect", parentContext }] }),
        }),
      ),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it("round-trips orchestration contracts while rejecting report-text injection", () => {
    const run = view({
      id: "a",
      state: "completed",
      finalText: "PRIVATE-REPORT",
      reportStatus: "available",
    });
    const contracts = [
      lifecycleContract(
        "stop",
        Array.from({ length: 12 }, (_, index) => ({
          runId: `run-${index}`,
          run: { ...run, id: `run-${index}` },
        })),
      ),
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
    ];
    for (const structuredContent of contracts) {
      const result = {
        content: [{ type: "text", text: "Existing human output" }],
        details: { unchanged: true },
        structuredContent,
      };
      expect(decodeSubagentProxyResult(JSON.stringify(result))).toEqual(result);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-REPORT");
    }
    // A cancelled await withholds every report, so a proxied one can't carry report text.
    const cancelled = cancelledAwaitContract({
      runs: [run],
      requestedRunIds: [run.id],
      until: "all_finished",
      cleanup: "confirmed",
      now: 0,
    });
    expect(
      decodeSubagentProxyResult(
        JSON.stringify({
          content: [],
          details: {},
          structuredContent: {
            ...cancelled,
            targets: [
              { ...cancelled.targets[0], report: { status: "delivered", text: "PRIVATE-REPORT" } },
            ],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it.each([
    { action: "list", callerRunId: "root" },
    { action: "discard", workspaceId: "w", ownerId: "root" },
    { action: "apply", workspaceId: "w", revisionId: "r", parentRunId: "root" },
  ])("rejects invalid or forged workspace arguments %j", (args) => {
    expect(
      rejection(
        decodeSubagentProxyRequest({
          tool: "agent_worktree",
          argumentsJson: JSON.stringify(args),
        }),
      ),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });
  it.each([
    {
      label: "accepts the text bound",
      source: JSON.stringify({
        content: [{ type: "text", text: Fn.pipe("x", Str.repeat(MAX_TOOL_OUTPUT_CHARS)) }],
      }),
      accepted: true,
      expectedDetails: {},
    },
    {
      label: "rejects text beyond the bound",
      source: JSON.stringify({
        content: [{ type: "text", text: Fn.pipe("x", Str.repeat(MAX_TOOL_OUTPUT_CHARS + 1)) }],
      }),
      accepted: false,
    },
  ])("$label", ({ source, accepted, expectedDetails }) => {
    const decoded = decodeSubagentProxyResult(source);
    expect(decoded !== undefined).toBe(accepted);
    if (accepted) expect(decoded?.details).toEqual(expectedDetails);
  });

  it("accepts the hard 32-item start bound and rejects a larger batch", () => {
    expect(Result.isSuccess(decodeSubagentProxyRequest(request(32)))).toBe(true);
    expect(rejection(decodeSubagentProxyRequest(request(33)))).toBeInstanceOf(
      InvalidSubagentRequestError,
    );
  });

  it.each([
    ["spoofed ancestry", "agent_start", { agents: [{ task: "spoof", parentRunId: "sibling" }] }],
  ])("rejects %s", (_label, tool, args) => {
    expect(
      rejection(decodeSubagentProxyRequest({ tool, argumentsJson: JSON.stringify(args) })),
    ).toMatchObject({ code: "proxy_request_invalid" });
  });

  it.each(["ask_user", "__proto__"])("rejects the unknown coordinator tool %s", (tool) => {
    const decoded = rejection(decodeSubagentProxyRequest({ tool, argumentsJson: "{}" }));
    expect(decoded).toBeInstanceOf(InvalidSubagentRequestError);
    expect(decoded).toMatchObject({
      code: "proxy_request_invalid",
    });
  });
});
