import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "pi-cosmic-core/testing";
import { PiExec, type PiExecContract } from "../src/boundary/host-exec.ts";
import { RepositoryProbe } from "../src/probe/repository-probe.ts";

const probeWith = (exec: PiExecContract["exec"]) =>
  RepositoryProbe.pipe(
    Effect.provide(RepositoryProbe.layer.pipe(Layer.provide(Layer.succeed(PiExec, { exec })))),
  );

describe("repository probe", () => {
  it.effect("parses Git status/diff and captures redacted probe spans", () => {
    const captured = makeCapturedTracer();
    const probe = probeWith((command, args) =>
      Effect.succeed({
        stdout:
          command === "gh"
            ? '{"number":17,"url":"https://git.private.example/team/project/pull/17"}\n'
            : args[0] === "diff"
              ? "4\t1\tfile.ts\n"
              : "## main...origin/main\n M file.ts\n",
        stderr: "",
        code: 0,
      }),
    );
    return Effect.gen(function* () {
      const { git, pullRequest } = yield* probe;
      expect(yield* git("/secret/project/not-recorded", () => true)).toMatchObject({
        modified: 1,
        linesAdded: 3,
      });
      expect(yield* pullRequest("/secret/project/not-recorded")).toEqual({
        number: 17,
        url: "https://git.private.example/team/project/pull/17",
      });
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(captured.spans.map((span) => span.name)).toEqual(
        expect.arrayContaining(["pi-cosmic-ui.probe.git", "pi-cosmic-ui.probe.pull-request"]),
      );
      expect(telemetry).not.toContain("secret");
      expect(telemetry).not.toContain("not-recorded");
      expect(telemetry).not.toContain("git.private.example");
    }).pipe(provideBuiltLayer(captured.layer));
  });

  it.effect.each([
    "https://github.com/team/project/pull/17",
    "https://git.example.test/team/project/pull/17?view=files#diff",
    "http://git.example.test/team/project/pull/17",
  ])("preserves the reported PR URL %s", (url) =>
    Effect.gen(function* () {
      const probe = yield* probeWith(() =>
        Effect.succeed({ stdout: JSON.stringify({ number: 17, url }), stderr: "", code: 0 }),
      );
      expect(yield* probe.pullRequest("/project")).toEqual({ number: 17, url });
    }),
  );

  it.effect.each([
    "not JSON",
    "17",
    "null",
    "[]",
    JSON.stringify({ number: 17 }),
    JSON.stringify({ number: "17", url: "https://github.com/team/project/pull/17" }),
    JSON.stringify({ number: 17, url: null }),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((number) =>
      JSON.stringify({ number, url: "https://github.com/team/project/pull/17" }),
    ),
    ...[
      "",
      "not a URL",
      "https://",
      "file:///tmp/17",
      "javascript:alert(17)",
      "https://github.com/team/project/pull/17\x1b]52;c;payload\x07",
      "https://github.com/team/project/pull/17\x1b\\injected",
      "https://github.com/team/project/pull/17\x07injected",
      "https://github.com/team/project/pull/17\nnext-line",
      "https://github.com/team/project/pull/17\rrewritten",
      "https://github.com/team/project/pull/17\tseparated",
      "https://github.com/team/project/pull/17\x7f",
      "https://github.com/team/project/pull/17\x9c",
    ].map((url) => JSON.stringify({ number: 17, url })),
  ])("ignores malformed or unsafe PR output %j", (stdout) =>
    Effect.gen(function* () {
      const probe = yield* probeWith(() => Effect.succeed({ stdout, stderr: "", code: 0 }));
      expect(yield* probe.pullRequest("/project")).toBeUndefined();
    }),
  );

  it.effect("ignores PR output from a failed command", () =>
    Effect.gen(function* () {
      const probe = yield* probeWith(() =>
        Effect.succeed({
          stdout: JSON.stringify({ number: 17, url: "https://github.com/team/project/pull/17" }),
          stderr: "unavailable",
          code: 1,
        }),
      );
      expect(yield* probe.pullRequest("/project")).toBeUndefined();
    }),
  );

  it.effect("rechecks currentness after a nonzero diff result", () => {
    let current = true;
    const probe = probeWith((_command, args) =>
      Effect.sync(() => {
        if (args[0] === "diff") {
          current = false;
          return { stdout: "", stderr: "failed", code: 1 };
        }
        return {
          stdout: "## main...origin/main\n M file.ts\n",
          stderr: "",
          code: 0,
        };
      }),
    );

    return Effect.gen(function* () {
      expect(yield* (yield* probe).git("/project", () => current)).toBeUndefined();
    });
  });
});
