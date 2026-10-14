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
            ? "17\n"
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
      expect(yield* pullRequest("/secret/project/not-recorded")).toBe(17);
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(captured.spans.map((span) => span.name)).toEqual(
        expect.arrayContaining(["pi-cosmic-ui.probe.git", "pi-cosmic-ui.probe.pull-request"]),
      );
      expect(telemetry).not.toContain("secret");
      expect(telemetry).not.toContain("not-recorded");
    }).pipe(provideBuiltLayer(captured.layer));
  });

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
