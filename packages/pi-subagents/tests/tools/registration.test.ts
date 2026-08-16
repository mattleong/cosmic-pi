// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { JsonObject } from "pi-cosmic-core";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { beforeAll, describe, expect, it } from "vitest";
import { piToolsForWriteIntent } from "../../src/run/tool-policy.ts";
import { type StartSubagentRequest } from "../../src/run/model.ts";
import {
  captureSubagentTools,
  context,
  fallbackProfileService,
  startCapturingService,
  view,
} from "./fixtures/tool-harness.ts";
import { subagentServiceFixture, extensionContextFixture } from "../fixtures/pi-host.ts";

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  it("allows Bash inspection while withholding direct Pi mutation tools", () => {
    const tools = ["read", "grep", "edit", "write", "bash", "mcp"];
    expect(piToolsForWriteIntent(tools, "read-only")).toEqual(["read", "grep", "bash"]);
    expect(piToolsForWriteIntent(tools, "writer")).toEqual(tools);
  });

  it("publishes a deterministic read-only-first delegation policy", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const tools = captureSubagentTools(subagentServiceFixture({}));
    const start = tools.get("subagent_start");
    const awaitTool = tools.get("subagent_await");
    const startPrompt = [
      start?.description,
      start?.promptSnippet,
      ...(start?.promptGuidelines ?? []),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    const awaitPrompt = [
      awaitTool?.description,
      awaitTool?.promptSnippet,
      ...(awaitTool?.promptGuidelines ?? []),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    const scenarios = [
      {
        name: "substantial parallel reconnaissance",
        prompt: startPrompt,
        evidence: [
          "two or more",
          "one to three read-only",
          "scout",
          "one narrow reconnaissance question",
          "follow relevant evidence as deeply as needed",
        ],
      },
      {
        name: "external research beside local inspection",
        prompt: startPrompt,
        evidence: ["researcher", "sourced external research", "independent workstreams"],
      },
      {
        name: "independent plan and review",
        prompt: startPrompt,
        evidence: ["planner", "reviewer", "independent verification"],
      },
      {
        name: "trivial or serial opt-out",
        prompt: startPrompt,
        evidence: ["skip subagent_start", "trivial", "tightly serial"],
      },
      {
        name: "explicit writer handoff",
        prompt: startPrompt,
        evidence: ["profile=worker only", "main agent does not edit", "one writer"],
      },
      {
        name: "dependency barrier awaiting",
        prompt: `${startPrompt} ${awaitPrompt}`,
        evidence: [
          "continue independent work",
          "final synthesis depends",
          "delivered automatically",
        ],
      },
    ] as const;

    expect(start?.promptSnippet).toContain("Parallelize independent reconnaissance");
    expect(awaitTool?.promptSnippet).toContain("dependency or synthesis barrier");
    for (const scenario of scenarios) {
      for (const evidence of scenario.evidence)
        expect(scenario.prompt, `${scenario.name}: ${evidence}`).toContain(evidence);
    }
    for (const guideline of [
      ...(start?.promptGuidelines ?? []),
      ...(awaitTool?.promptGuidelines ?? []),
    ])
      expect(guideline).toMatch(/\bsubagent_(?:start|await|models|status|reply)\b/);
  });

  it("removes every Herdr orchestration tool from parent-resolved writer tools", async () => {
    const herdrTools = [
      "herdr_agent_start",
      "herdr_agent_list",
      "herdr_agent_status",
      "herdr_agent_await",
      "herdr_agent_read",
      "herdr_agent_send",
      "herdr_agent_stop",
    ];
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests), [
      "read",
      "edit",
      ...herdrTools,
    ]).get("subagent_start");

    await tool?.execute(
      "call",
      { agents: [{ task: "Implement auth", profile: "worker" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests[0]?.writeIntent).toBe("writer");
    expect(requests[0]?.activeTools).toEqual(["read", "edit"]);
  });

  it("registers focused tools with non-overlapping parameter contracts", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const tools = captureSubagentTools(subagentServiceFixture({}));
    expect([...tools.keys()]).toEqual([
      "subagent_models",
      "subagent_start",
      "subagent_list",
      "subagent_status",
      "subagent_await",
      "subagent_send",
      "subagent_reply",
      "subagent_lifecycle",
      "subagent_rename",
    ]);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const schema = (name: string) =>
      tools.get(name)?.parameters as
        | {
            readonly properties?: Readonly<JsonObject>;
            readonly required?: ReadonlyArray<string>;
            readonly additionalProperties?: boolean;
            readonly anyOf?: ReadonlyArray<{
              readonly properties?: Readonly<JsonObject>;
              readonly required?: ReadonlyArray<string>;
              readonly additionalProperties?: boolean;
            }>;
          }
        | undefined;
    const properties = (name: string): ReadonlyArray<string> =>
      Object.keys(schema(name)?.properties ?? {});
    expect(properties("subagent_models")).toEqual(["profile"]);
    expect(properties("subagent_start")).toEqual(["agents"]);
    expect(properties("subagent_list")).toEqual([]);
    expect(properties("subagent_status")).toEqual(["runIds"]);
    expect(properties("subagent_await")).toEqual(["runIds", "until"]);
    expect(schema("subagent_status")?.required).toEqual(["runIds"]);
    expect(schema("subagent_await")?.required).toEqual(["runIds", "until"]);
    expect(properties("subagent_send")).toEqual(["runIds", "message"]);
    expect(properties("subagent_reply")).toEqual(["runId", "message"]);
    expect(properties("subagent_lifecycle")).toEqual([]);
    const lifecycleBranches = schema("subagent_lifecycle")?.anyOf ?? [];
    expect(lifecycleBranches).toHaveLength(2);
    expect(Object.keys(lifecycleBranches[0]?.properties ?? {})).toEqual([
      "action",
      "runIds",
      "message",
    ]);
    expect(Object.keys(lifecycleBranches[1]?.properties ?? {})).toEqual(["action", "runIds"]);
    expect(lifecycleBranches.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(properties("subagent_rename")).toEqual(["runId", "name"]);
    for (const name of [
      "subagent_models",
      "subagent_start",
      "subagent_list",
      "subagent_status",
      "subagent_await",
      "subagent_send",
      "subagent_reply",
      "subagent_rename",
    ])
      expect(schema(name)?.additionalProperties).toBe(false);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startSchema = schema("subagent_start") as {
      readonly properties?: {
        readonly agents?: {
          readonly items?: {
            readonly additionalProperties?: boolean;
            readonly properties?: Readonly<
              Record<string, { readonly pattern?: string; readonly description?: string }>
            >;
            readonly required?: ReadonlyArray<string>;
          };
        };
      };
    };
    const startItem = startSchema.properties?.agents?.items;
    expect(startItem?.additionalProperties).toBe(false);
    expect(startItem?.required).toEqual(["task"]);
    expect(startItem?.properties?.task?.pattern).toBe(".*\\S.*");
    expect(startItem?.properties).not.toHaveProperty("backend");
    expect(startItem?.properties).not.toHaveProperty("model");
    const startTool = tools.get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startParameters = startTool?.parameters as TSchema;
    expect(Check(startParameters, { agents: [{ profile: "scout", task: "Inspect" }] })).toBe(true);
    expect(
      Check(startParameters, {
        agents: [{ model: "pi/openai-codex/gpt-5.6-sol", profile: "scout", task: "Inspect" }],
      }),
    ).toBe(false);
    expect(
      Check(startParameters, {
        agents: [{ backend: "auto", profile: "scout", task: "Inspect" }],
      }),
    ).toBe(false);
    expect(
      Check(startParameters, {
        agents: [{ model: "openai-codex/gpt-5.6-sol", profile: "scout", task: "Inspect" }],
      }),
    ).toBe(false);
    expect(() => startTool?.prepareArguments?.({ task: "Inspect", profile: "scout" })).toThrow(
      "[invalid_start_shape]",
    );
    expect(() =>
      startTool?.prepareArguments?.({
        agents: [{ backend: "auto", profile: "scout", task: "Inspect" }],
      }),
    ).toThrow("[launch_override_not_allowed]");
    expect(() =>
      startTool?.prepareArguments?.({
        agents: [{ model: "openai/model", profile: "scout", task: "Inspect" }],
      }),
    ).toThrow("[launch_override_not_allowed]");
    for (const field of ["execution", "context", "writeIntent", "effort"])
      expect(() =>
        startTool?.prepareArguments?.({
          agents: [{ task: "Inspect", [field]: "override" }],
        }),
      ).toThrow("[launch_override_not_allowed]");
    expect(tools.get("subagent_start")?.description).toContain("background subagents");
    expect(tools.get("subagent_start")?.description).toContain(
      "selected profile supplies host, runtime, model, effort, context, write intent, fast mode, and closeOnReport",
    );
    expect(tools.get("subagent_status")?.description).toContain("capabilities");
    expect(tools.get("subagent_send")?.description).toContain("running subagents");
    expect(tools.get("subagent_reply")?.description).toContain("one subagent");
    expect(tools.get("subagent_lifecycle")?.description).toContain(
      "Message is accepted only for resume",
    );
    for (const tool of tools.values()) {
      expect(tool.renderShell).toBe("default");
      expect(tool.renderCall).toBeTypeOf("function");
      expect(tool.renderResult).toBeTypeOf("function");
    }
  });

  it("advertises one canonical launch shape and enforces its cardinality", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const service = subagentServiceFixture({
      start: () => Effect.succeed(view()),
    });
    const tool = captureSubagentTools(service).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const schema = tool?.parameters as { readonly properties?: Readonly<JsonObject> } | undefined;

    expect(Object.keys(schema?.properties ?? {})).toEqual(["agents"]);
    await expect(
      tool?.execute(
        "call",
        { agents: [{ task: "Probe", model: " " }] },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({ code: "launch_override_not_allowed" });
    await expect(
      tool?.execute(
        "call",
        { agents: [{ task: "Probe", backend: "claude-cli" }] },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({ code: "launch_override_not_allowed" });
    await expect(
      tool?.execute("call", { agents: [] }, undefined, undefined, context),
    ).rejects.toThrow("requires between 1 and 12 agents");
    await expect(
      tool?.execute(
        "call",
        {
          agents: Array.from({ length: 13 }, (_, index) => ({
            task: `Review area ${index + 1}`,
          })),
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("requires between 1 and 12 agents");
  });

  it("uses captured cwd and trust even when invocation getters later change or throw", async () => {
    const requests: StartSubagentRequest[] = [];
    let cwdReads = 0;
    let trustReads = 0;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const mutable = extensionContextFixture({
      ...context,
    });
    Object.defineProperty(mutable, "cwd", {
      configurable: true,
      get: () => {
        cwdReads += 1;
        throw new Error("stale cwd getter");
      },
    });
    Object.defineProperty(mutable, "isProjectTrusted", {
      configurable: true,
      get: () => {
        trustReads += 1;
        return () => true;
      },
    });
    const tools = captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      fallbackProfileService,
      undefined,
      { cwd: "/captured/project", projectTrusted: false },
    );
    const models = await tools
      .get("subagent_models")
      ?.execute("call", {}, undefined, undefined, mutable);
    expect(models?.content[0]?.text).toContain("Profile omitted → generalist");
    await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: [{ task: "Use captured environment" }],
      },
      undefined,
      undefined,
      mutable,
    );
    expect(requests[0]).toMatchObject({ cwd: "/captured/project", projectTrusted: false });
    expect(cwdReads).toBe(0);
    expect(trustReads).toBe(0);
  });
});
