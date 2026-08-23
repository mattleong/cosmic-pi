import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { PiExec } from "../src/probe/pi-exec.ts";
import { makeCapturedTracer } from "pi-cosmic-core/testing";
import { RepositoryProbe } from "../src/probe/repository-probe.ts";

// Pure leak-check serialization stays outside Effect code on purpose: it scans captured
// telemetry spans for secret path fragments.
const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

describe("repository probe", () => {
  it.effect("parses Git status/diff and captures redacted probe spans", () => {
    const captured = makeCapturedTracer();
    const exec = Layer.succeed(
      PiExec,
      PiExec.of({
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
            killed: false,
          }),
      }),
    );
    return Effect.gen(function* () {
      const probe = yield* RepositoryProbe;
      expect(yield* probe.git("/secret/project/not-recorded")).toMatchObject({
        modified: 1,
        linesAdded: 3,
      });
      expect(yield* probe.pullRequest("/secret/project/not-recorded")).toBe(17);
      const telemetry = serializedSnapshot(
        captured.spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
      );
      expect(captured.spans.map((span) => span.name)).toEqual(
        expect.arrayContaining(["pi-cosmic-ui.probe.git", "pi-cosmic-ui.probe.pull-request"]),
      );
      expect(telemetry).not.toContain("secret");
      expect(telemetry).not.toContain("not-recorded");
    }).pipe(
      provideBuiltLayer(
        Layer.merge(RepositoryProbe.layer.pipe(Layer.provide(exec)), captured.layer),
      ),
    );
  });
});
