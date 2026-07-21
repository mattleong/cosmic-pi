import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAdvisorProjection } from "../src/advisor-projection.ts";
import { normalizeAdvisorConfig } from "../src/config.ts";
import { emptyAdvisorOutcomes } from "../src/settings.ts";

const initial = {
  config: normalizeAdvisorConfig({}, ""),
  metrics: {
    attempted: 0,
    pass: 0,
    revise: 0,
    failure: 0,
    discarded: 0,
    outcomes: emptyAdvisorOutcomes(),
  },
  paused: false,
  started: false,
};

it.effect("deeply freezes snapshots and preserves publication on projection failure", () =>
  Effect.gen(function* () {
    const projection = yield* makeAdvisorProjection(initial);
    const before = projection.getSnapshot();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.config)).toBe(true);
    expect(Object.isFrozen(before.metrics)).toBe(true);

    const updated = {
      ...initial,
      config: { ...initial.config, enabled: false },
      metrics: {
        ...initial.metrics,
        attempted: 1,
        outcomes: { ...initial.metrics.outcomes, findings: 1 },
      },
      paused: true,
    };
    yield* projection.replace(updated);
    const after = projection.getSnapshot();
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ paused: true, metrics: { attempted: 1 } });
    expect(before).toMatchObject({ paused: false, metrics: { attempted: 0 } });
    expect(after.config.enabled).toBe(false);
    expect(before.config.enabled).toBe(true);
    expect(before.metrics.outcomes.findings).toBe(0);

    const invalid = { ...initial, config: { ...initial.config, capability: () => 42 } };
    const result = yield* projection.replace(invalid as typeof initial).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(projection.getSnapshot()).toBe(after);
  }),
);
