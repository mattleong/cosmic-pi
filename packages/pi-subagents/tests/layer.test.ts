// Complete application-layer composition is the boundary under test.
// @effect-diagnostics effect/strictEffectProvide:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeSubagentLayer } from "../src/layer.ts";
import { SubagentService } from "../src/run/service.ts";

it.effect("composes the complete Subagents application layer", () =>
  SubagentService.use((service) => service.projection).pipe(
    Effect.tap((projection) =>
      Effect.sync(() => {
        expect(projection).toEqual({ revision: 0, runs: [] });
      }),
    ),
    Effect.provide(
      makeSubagentLayer({
        cwd: process.cwd(),
        agentDirectory: `${process.cwd()}/.pi-subagents-nonexistent-test-agent`,
        projectTrusted: false,
        publish: () => {},
        notify: () => ({ deliveredCompletionKeys: [], deliveredActionKeys: [] }),
      }),
    ),
    Effect.scoped,
  ),
);
