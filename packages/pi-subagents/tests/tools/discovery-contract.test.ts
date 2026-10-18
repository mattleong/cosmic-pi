import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { decodeSubagentContract, type SubagentContract } from "../../src/tools/contract-schema.ts";
import { modelsContract, statusListContract } from "../../src/tools/discovery-contract.ts";
import { view } from "../fixtures/run-view.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool } from "./fixtures/tool-harness.ts";

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

const decodeStatus = decodeSubagentContract("subagent_status");
const statusList = (contract: ReturnType<typeof decodeStatus>) =>
  contract && "runs" in contract ? contract : undefined;

describe("discovery contracts", () => {
  effectTest(
    "lists the complete visible hierarchy beyond action and retention bounds without reading reports",
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
      const input = [...children, privateRun];
      const tools = captureSubagentTools(
        subagentServiceDouble({
          list: Effect.succeed(input),
          consumeCompletions: () => Effect.die("Discovery must not consume reports"),
        }),
      );
      const result = yield* step(() => executeTool(tools.get("subagent_status")!, {}));
      const contract = statusList(decodeStatus(result.structuredContent))!;
      expect(contract.runs.map((run) => run.runId)).toEqual([
        "parent",
        ...children.map((run) => run.id),
      ]);
      expect(contract.runs[0]).toMatchObject({
        parentRunId: "root",
        depth: 1,
        report: { status: "deferred" },
      });
      expect(contract.runs[1]).toMatchObject({
        parentRunId: "parent",
        depth: 2,
        report: { status: "already_delivered" },
      });
      expectPrivate(contract);
      expect(input.at(-1)?.reportStatus).toBe("available");
      expect(statusListContract([]).runs).toEqual([]);
      expect(
        decodeStatus({
          ...contract,
          runs: [{ ...contract.runs[0], report: { status: "read_back", text: "PRIVATE-REPORT" } }],
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
              runtime: "claude",
              model: "sonnet",
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
    expect(decodeSubagentContract("subagent_models")(contract)).toEqual(contract);
    expect(JSON.stringify(contract)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    // The v1 contract keeps reporting the retired route fields as constants.
    expect(contract.profiles[0]?.candidates[0]).toMatchObject({
      host: "local",
      closeOnReport: true,
    });
  });
});
