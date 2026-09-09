import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { gradeAnswer } from "../../eval/answer-check.ts";
import {
  fixtureDefinitions,
  freshDispatchMetrics,
  FixtureBoundaryError,
} from "../../eval/fixture-tools.ts";
import { materializeEffect } from "../../eval/host-files.ts";
import { checkAnswer } from "../../eval/score.ts";
import { wordingTasks } from "../../eval/wording-tasks.ts";
import { makeCodeModeToolExecute } from "../../src/tools/execution.ts";
import { codeModeStateFixture, extensionContextFixture } from "../support/host.ts";

const inventory = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ id: Schema.String, enabled: Schema.Boolean, tests: Schema.Finite }),
    ),
  ),
);
const index = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ file: Schema.String, selected: Schema.Boolean })),
  ),
);
const manifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ index: Schema.String })),
);
const score = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ score: Schema.Finite })),
);
const ids = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const attestations = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String }))),
);
const proposal = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, title: Schema.String })),
);

describe("wording fixture oracles", () => {
  it("recomputes all six answers from the data, independently of the frozen expectations", () => {
    const [a, b, c, d, e, f] = wordingTasks;
    const enabled = Object.values(a!.files)
      .flatMap((content) => inventory(content))
      .filter((record) => record.enabled);
    expect({
      enabledCount: enabled.length,
      totalTests: enabled.reduce((sum, record) => sum + record.tests, 0),
      ids: enabled.map((record) => record.id).sort(),
    }).toEqual(a!.expected);
    const selected = index(b!.files[manifest(b!.files["manifest.json"]!).index]!).filter(
      (record) => record.selected,
    );
    expect({
      selectedFiles: selected.length,
      totalScore: selected.reduce((sum, record) => sum + score(b!.files[record.file]!).score, 0),
    }).toEqual(b!.expected);
    const required = ids(c!.files["required.json"]!);
    const passed = new Set(
      attestations(c!.files["attestations.json"]!)
        .filter((record) => record.status === "passed")
        .map((record) => record.id),
    );
    const missing = required.filter((id) => !passed.has(id)).sort();
    expect({
      checked: required.length,
      verified: required.length - missing.length,
      missing,
    }).toEqual(c!.expected);
    const files = Object.entries(d!.files)
      .filter(([path]) => /^notes\/[^/]+\.txt$/.test(path))
      .sort(([a], [b]) => a.localeCompare(b));
    const matches = files.flatMap(([path, content]) =>
      content
        .split("\n")
        .flatMap((text, n) =>
          text.startsWith("@@ BLOCKED ") ? [{ path, line: n + 1, text }] : [],
        ),
    );
    expect({ checkedFiles: files.length, matches }).toEqual(d!.expected);
    expect(e!.files["notice.txt"]).toBe(e!.expected);
    expect({
      needsApproval: true,
      options: ["proposals/a.json", "proposals/b.json"].map((path) => {
        const { id, title } = proposal(f!.files[path]!);
        return { id, title };
      }),
    }).toEqual(f!.expected);
    for (const task of wordingTasks) {
      expect(checkAnswer(JSON.stringify(task.expected), task)).toBe(true);
      expect(checkAnswer("null", task)).toBe(false);
    }
    expect(checkAnswer(JSON.stringify(e!.files["notice.txt"]!.trimEnd()), e!)).toBe(false);
  });

  it("retains bounded mismatch locations without retaining answer values or unexpected keys", () => {
    const task = wordingTasks[2]!;
    const result = gradeAnswer(
      '{"checked":8,"verified":6,"missing":["private-value","cache"],"private-key":"private-value"}',
      task,
    );
    expect(result.correct).toBe(false);
    expect(result.mismatchPaths).toEqual(["/missing/0", "/<extra-key>"]);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(gradeAnswer('{"checked":8}', task).mismatchPaths).toContain("/verified/<missing>");
    expect(gradeAnswer("not JSON", task).mismatchPaths).toEqual(["<invalid-json>"]);
    expect(gradeAnswer("[]", wordingTasks[0]!).mismatchPaths.length).toBeLessThanOrEqual(8);
  });

  it.live(
    "blocks premature detail access and directory-wide grep in direct and real nested dispatch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "wording-approval-test-" }),
        );
        const task = wordingTasks[5]!;
        yield* materializeEffect(root, task);
        yield* fs.symlink(paths.join(root, "details"), paths.join(root, "alias"));
        const ctx = extensionContextFixture({ cwd: root });
        const directMetrics = freshDispatchMetrics();
        const direct = fixtureDefinitions(root, directMetrics, false, task.blockedReadPaths);
        yield* Effect.tryPromise(() =>
          direct.read.execute("metadata", { path: "proposals/a.json" }, undefined, undefined, ctx),
        );
        for (const path of [
          "details/alpha.json",
          "details/../details/beta.json",
          "alias/alpha.json",
        ])
          yield* Effect.tryPromise(() =>
            expect(
              direct.read.execute("blocked", { path }, undefined, undefined, ctx),
            ).rejects.toBeInstanceOf(FixtureBoundaryError),
          );
        yield* Effect.tryPromise(() =>
          expect(
            direct.grep.execute(
              "blocked-search",
              { path: ".", pattern: "decision" },
              undefined,
              undefined,
              ctx,
            ),
          ).rejects.toBeInstanceOf(FixtureBoundaryError),
        );
        expect(directMetrics.boundaryViolations).toBe(4);
        const nestedMetrics = freshDispatchMetrics();
        const run = Effect.runPromiseWith(yield* Effect.context());
        const execute = makeCodeModeToolExecute({
          isCurrent: () => true,
          getState: () => codeModeStateFixture(),
          runInSession: (effect, signal) => run(effect, { signal }),
          definitions: fixtureDefinitions(root, nestedMetrics, true, task.blockedReadPaths),
          events: createEventBus(),
          sessionId: "wording-approval-test",
        });
        yield* Effect.tryPromise(() =>
          execute(
            "nested-approval",
            { code: "return await tools.pi.read({path: 'alias/alpha.json'});" },
            undefined,
            undefined,
            ctx,
          ),
        ).pipe(Effect.ignore);
        expect(nestedMetrics.boundaryViolations).toBe(1);
        expect(nestedMetrics.nestedErrors).toBe(1);
        expect(nestedMetrics.nestedSucceeded).toBe(0);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});
