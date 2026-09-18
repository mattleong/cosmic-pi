import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nodePlatformLayer } from "pi-cosmic-core";
import { loadCases, requiredCases, runCase } from "./test262/runner.js";

// Registration never depends on fixture I/O, so missing inventory cannot silently remove tests.
describe("mandatory pinned Test262 selection", () => {
  for (const [file, upstream] of requiredCases) {
    it.live(upstream, () =>
      Effect.gen(function* () {
        // Eagerly verify the complete inventory and all hashes before running any fixture.
        const cases = yield* loadCases();
        const entry = cases.find((candidate) => candidate.file === file);
        expect(entry).toBeDefined();
        const result = yield* runCase(entry!);
        expect(result).toMatchObject({ ok: true, value: true });
      }).pipe(Effect.provide(nodePlatformLayer)),
    );
  }
});
