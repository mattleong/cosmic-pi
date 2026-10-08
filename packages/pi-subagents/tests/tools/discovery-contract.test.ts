import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { InvalidSubagentRequestError, SubagentNotFoundError } from "../../src/run/errors.ts";
import { PROFILE_IDS } from "../../src/profiles/model.ts";
import { decodeSubagentContract, type SubagentContract } from "../../src/tools/contract-schema.ts";
import {
  listContract,
  modelsContract,
  renameContract,
} from "../../src/tools/discovery-contract.ts";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { view } from "../fixtures/run-view.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, profileServiceFor } from "./fixtures/tool-harness.ts";

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

describe("discovery contracts", () => {
  effectTest(
    "returns the complete visible hierarchy beyond action and retention bounds without reading reports",
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
          // Any attempted consumption, even an empty one, would violate list's read-only contract.
          consumeCompletions: () => Effect.die("Discovery must not consume reports"),
        }),
      );
      const result = yield* step(() => executeTool(tools.get("subagent_list")!, {}));
      const contract = decodeSubagentContract("subagent_list", result.structuredContent)!;
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
      expect(listContract([]).runs).toEqual([]);
      // The schema protects report privacy even for an externally decoded/proxied result.
      expect(
        decodeSubagentContract("subagent_list", {
          ...contract,
          runs: [{ ...contract.runs[0], report: { status: "read_back", text: "PRIVATE-REPORT" } }],
        }),
      ).toBeUndefined();
    },
  );

  effectTest(
    "uses the actual renamed target and keeps domain failures and uncertainty structured",
    function* () {
      const tools = captureSubagentTools(
        subagentServiceDouble({
          rename: (id) =>
            id === "parent"
              ? Effect.succeed({ ...privateRun, name: "accepted-name" })
              : id === "uncertain"
                ? Effect.fail(
                    new InvalidSubagentRequestError({
                      code: "rename_outcome_uncertain",
                      message: "Outcome is unknown.",
                    }),
                  )
                : Effect.fail(new SubagentNotFoundError({ id, message: "Run not found" })),
          consumeCompletions: () => Effect.die("Rename must not consume reports"),
        }),
      );
      const rename = tools.get("subagent_rename")!;
      const result = yield* step(() =>
        executeTool(rename, { runId: "parent", name: "requested-name" }),
      );
      const contract = decodeSubagentContract("subagent_rename", result.structuredContent)!;
      expect(contract).toMatchObject({
        requestedRunId: "parent",
        outcome: "succeeded",
        target: { runId: "parent", name: "accepted-name", report: { status: "deferred" } },
      });
      expectPrivate(contract);
      for (const [runId, disposition] of [
        ["missing", "failed"],
        ["uncertain", "unconfirmed"],
      ]) {
        const failed = yield* step(() => executeTool(rename, { runId, name: "unused" }));
        expect(decodeSubagentContract("subagent_rename", failed.structuredContent)).toMatchObject({
          requestedRunId: runId,
          outcome: "failed",
          failure: { disposition },
        });
      }
      const receipt = renameContract({ runId: "parent", run: privateRun });
      if (receipt.outcome !== "succeeded") throw new Error("Expected a successful rename receipt");
      expect(
        decodeSubagentContract("subagent_rename", {
          ...receipt,
          target: {
            ...receipt.target,
            report: { status: "delivered", text: "PRIVATE-REPORT" },
          },
        }),
      ).toBeUndefined();
    },
  );

  effectTest(
    "filters profiles without reordering or clipping static candidates or claiming launch readiness",
    function* () {
      const profiles = profileServiceFor({
        profiles: {
          scout: [
            declaredCandidate("missing/not-catalogued"),
            declaredCandidate("sonnet", { runtime: "claude", effort: "default" }),
            declaredCandidate("gpt-5.6-sol", { runtime: "codex", openaiFastMode: true }),
          ],
          worker: "disabled",
        },
      });
      const tools = captureSubagentTools(subagentServiceDouble({}), {
        profiles,
        // Model discovery must not execute preflight/auth/spawn.
        registry: {
          resolve: () => Effect.die("No launch"),
          preflight: () => Effect.die("No preflight"),
        },
      });
      const models = tools.get("subagent_models")!;
      const all = decodeSubagentContract(
        "subagent_models",
        (yield* step(() => executeTool(models, {}))).structuredContent,
      )!;
      const filtered = decodeSubagentContract(
        "subagent_models",
        (yield* step(() => executeTool(models, { profile: "scout" }))).structuredContent,
      )!;
      expect(all.profiles.map((profile) => profile.id)).toEqual(PROFILE_IDS);
      expect(all.profiles.find((profile) => profile.id === "worker")?.candidates).toEqual([]);
      expect(filtered.fallbackProfile).toBe("generalist");
      expect(filtered.profiles).toEqual(all.profiles.filter((profile) => profile.id === "scout"));
      expect(filtered.profiles[0]).toMatchObject({
        source: "global",
        isDefault: false,
        defaultWriteIntent: "read-only",
      });
      expect(filtered.profiles[0]!.candidates).toMatchObject([
        {
          host: "local",
          runtime: "pi",
          model: "missing/not-catalogued",
          status: "skipped",
          openaiFastMode: false,
          closeOnReport: true,
        },
        {
          host: "local",
          runtime: "claude",
          model: "sonnet",
          effort: "default",
          context: "fresh",
          writeIntent: "read-only",
          status: "eligible",
        },
        {
          host: "local",
          runtime: "codex",
          model: "gpt-5.6-sol",
          status: "eligible",
          openaiFastMode: true,
        },
      ]);
      expect(
        filtered.profiles[0]!.candidates.every((candidate) => candidate.reason.length > 0),
      ).toBe(true);
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
              host: "local",
              runtime: "claude",
              model: "sonnet",
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
              closeOnReport: true,
              status: "skipped",
              reason: "Authorization: Bearer sk-reason-abcdefghijklmnopqrstuvwxyz",
            },
          ],
        },
      ],
      "generalist",
    );
    expect(decodeSubagentContract("subagent_models", contract)).toEqual(contract);
    expect(JSON.stringify(contract)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
