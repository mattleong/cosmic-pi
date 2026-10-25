import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { decodeSubagentContract, type SubagentContract } from "../../src/tools/contract-schema.ts";
import { MAIN_AGENT_ID, mainListEntry, runListEntry } from "../../src/run/agent-messaging.ts";
import { modelsContract } from "../../src/tools/discovery-contract.ts";
import { view } from "../fixtures/run-view.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool } from "./fixtures/tool-harness.ts";
import * as Arr from "effect/Array";

const privateRun = view({
  id: "parent",
  parentRunId: "root",
  depth: 1,
  state: "completed",
  name: "api_key=sk-name-abcdefghijklmnopqrstuvwxyz",
  task: "PRIVATE-TASK",
  cwd: "/PRIVATE-CWD",
  sessionId: "PRIVATE-SESSION",
  sessionFile: "/PRIVATE-SESSION-FILE",
  pid: 654321,
  progress: "PRIVATE-PROGRESS",
  sessionEvents: [{ type: "assistant", text: "PRIVATE-EVENT", createdAt: 1 }],
  finalText: "PRIVATE-REPORT",
  reportStatus: "available",
  reportGeneration: 1,
});

const expectPrivate = (value: SubagentContract) => {
  const serialized = JSON.stringify(value);
  for (const hidden of [
    "PRIVATE-",
    "654321",
    "sk-name-abcdefghijklmnopqrstuvwxyz",
    "finalText",
    "sessionEvents",
  ])
    expect(serialized).not.toContain(hidden);
};

const decodeList = decodeSubagentContract("agent_list");

describe("discovery contracts", () => {
  effectTest(
    "lists the complete hierarchy beyond action and retention bounds without reading reports",
    function* () {
      const children = Array.from({ length: 64 }, (_, index) =>
        view({
          id: `child-${index}`,
          parentRunId: "parent",
          depth: 2,
          state: "completed",
          reportStatus: index === 0 ? "delivered" : "available",
          finalText: "PRIVATE-REPORT",
          reportGeneration: 1,
        }),
      );
      const input = [{ ...privateRun, task: "Map the API" }, ...children];
      const tools = captureSubagentTools(
        subagentServiceDouble({
          agentList: () =>
            Effect.succeed({
              agents: [
                mainListEntry("idle", MAIN_AGENT_ID),
                ...Arr.map(input, (run) => runListEntry(run, MAIN_AGENT_ID)),
              ],
              missingIds: [],
            }),
          consumeCompletions: () => Effect.die("Discovery must not consume reports"),
        }),
      );
      const result = yield* step(() => executeTool(tools.get("agent_list")!, {}));
      const contract = decodeList(result.structuredContent)!;
      expect(Arr.map(contract.agents, (agent) => agent.id)).toEqual([
        MAIN_AGENT_ID,
        "parent",
        ...Arr.map(children, (run) => run.id),
      ]);
      expect(contract.agents[1]).toMatchObject({ parentId: MAIN_AGENT_ID, depth: 1 });
      expect(contract.agents[2]).toMatchObject({ parentId: "parent", depth: 2 });
      expectPrivate(contract);
      expect(input[0]?.reportStatus).toBe("available");
      expect(
        decodeList({
          ...contract,
          agents: [{ ...contract.agents[1], finalText: "PRIVATE-REPORT" }],
        }),
      ).toBeUndefined();
    },
  );

  it("redacts discovery diagnostics while excluding extra route metadata", () => {
    const contract = modelsContract(
      [
        {
          id: "scout",
          description: "api_key=sk-description-abcdefghijklmnopqrstuvwxyz",
          source: "session",
          isDefault: false,
          defaultContext: "fresh",
          defaultWriteIntent: "read-only",
          candidates: [
            {
              model: "claude-bridge/claude-sonnet-5-5",
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
              status: "skipped",
              reason: "Authorization: Bearer sk-reason-abcdefghijklmnopqrstuvwxyz",
            },
          ],
        },
      ],
      "generalist",
    );
    expect(decodeSubagentContract("agent_profiles")(contract)).toEqual(contract);
    expect(JSON.stringify(contract)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
