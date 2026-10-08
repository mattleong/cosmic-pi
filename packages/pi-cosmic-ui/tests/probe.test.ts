import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "pi-cosmic-core/testing";
import { makeRepositoryProbe } from "../src/probe/repository-probe.ts";

describe("repository probe", () => {
  it.effect("parses Git status/diff and captures redacted probe spans", () => {
    const captured = makeCapturedTracer();
    const probe = makeRepositoryProbe({
      exec: (command, args) =>
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
    });
    return Effect.gen(function* () {
      expect(yield* probe.git("/secret/project/not-recorded", () => true)).toMatchObject({
        modified: 1,
        linesAdded: 3,
      });
      expect(yield* probe.pullRequest("/secret/project/not-recorded")).toBe(17);
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
    const probe = makeRepositoryProbe({
      exec: (_command, args) =>
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
    });

    return Effect.gen(function* () {
      expect(yield* probe.git("/project", () => current)).toBeUndefined();
    });
  });
});
