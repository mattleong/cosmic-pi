import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { workflowToolExample } from "../../src/tools/workflow.ts";
import { fragment, recipe, runRecipe, type GuideCall } from "./fixtures/authoring-guide.ts";

const finding = {
  file: "src/auth.ts",
  line: 12,
  desc: "A denied request reaches the write path",
  evidence: "The denied fixture invokes persist() before the guard returns.",
};
const confirmed = { status: "confirmed", evidence: "The denied-request regression reproduces it." };
const refuted = {
  status: "refuted",
  evidence: "The caller returns before persist(); traced both branches.",
};
const uncertain = { status: "unverified", evidence: "The caller contract is unresolved." };
const decodeOutcomes = Schema.decodeUnknownSync(
  Schema.Struct({
    confirmed: Schema.Array(Schema.Json),
    refuted: Schema.Array(Schema.Json),
    unverified: Schema.Array(Schema.Json),
    uncovered: Schema.Array(Schema.Json),
  }),
);
const decodeCoverage = Schema.decodeUnknownSync(
  Schema.Struct({
    searched: Schema.Array(Schema.String),
    uncovered: Schema.Array(Schema.Json),
    rounds: Schema.Int,
  }),
);
const auditArgs = { scope: "auth", areas: ["src/auth.ts"], lenses: [] };

interface ReviewRecipe {
  readonly name: string;
  readonly source: string;
  readonly args: Schema.Json;
  readonly candidate: Schema.Json;
}

const reviewRecipes = Effect.gen(function* () {
  return [
    { name: "tool", source: workflowToolExample, args: null, candidate: finding },
    {
      name: "find-bugs",
      source: yield* recipe("find-bugs"),
      args: { files: ["src/auth.ts"], known: [], checklists: ["authorization"] },
      candidate: { ...finding, reachable: "The public write endpoint calls this path." },
    },
    {
      name: "review-change",
      source: yield* recipe("review-change"),
      args: { goal: "authorization", lenses: ["contracts"] },
      candidate: finding,
    },
    {
      name: "exhaustive-review",
      source: yield* recipe("exhaustive-review"),
      args: auditArgs,
      candidate: finding,
    },
  ];
});

const reviewReply = (entry: ReviewRecipe, verification: Schema.Json, call: GuideCall) => {
  if (call.options.phase === "Verify") return verification;
  if (call.options.phase === "Critic") return { gaps: [] };
  return entry.name === "review-change"
    ? { findings: [entry.candidate] }
    : { bugs: [entry.candidate] };
};

describe("workflow recipe outcomes", () => {
  it.live(
    "retains uncertainty and missing evidence instead of turning it into refutation",
    () =>
      Effect.gen(function* () {
        const cases = [
          { verification: confirmed, category: "confirmed" },
          { verification: refuted, category: "refuted" },
          { verification: uncertain, category: "unverified" },
          { verification: null, category: "unverified" },
          { verification: { status: "confirmed" }, category: "unverified" },
          { verification: { status: "confirmed", evidence: "  " }, category: "unverified" },
          { verification: { status: "refuted", evidence: "" }, category: "unverified" },
        ] as const;
        for (const entry of yield* reviewRecipes) {
          for (const { verification, category } of cases) {
            const run = yield* runRecipe(entry.source, entry.args, (call) =>
              Effect.succeed(reviewReply(entry, verification, call)),
            );
            const outcomes = decodeOutcomes(run.value);
            expect(outcomes[category], entry.name).toHaveLength(1);
            expect(outcomes[category][0]).toMatchObject({ finding: entry.candidate });
            const settled = verification && !("evidence" in verification) ? null : verification;
            expect(outcomes[category][0]).toMatchObject({ verification: settled });
            for (const other of ["confirmed", "refuted", "unverified"] as const)
              if (other !== category) expect(outcomes[other]).toEqual([]);
            expect(run.warnings).toEqual([]);
          }
        }
      }),
    30_000,
  );

  it.live(
    "keeps distinct nearby candidates separate while retaining duplicate evidence",
    () =>
      Effect.gen(function* () {
        for (const entry of yield* reviewRecipes) {
          const first =
            entry.name === "find-bugs" ? { ...finding, reachable: "Public endpoint" } : finding;
          const supporting = {
            ...first,
            evidence: "A second trace confirms the same denied request.",
          };
          const nearby = {
            ...first,
            line: finding.line + 1,
            desc: "An unrelated rollback candidate",
          };
          const run = yield* runRecipe(entry.source, entry.args, (call) =>
            Effect.succeed(
              call.options.phase === "Verify"
                ? call.prompt.includes(nearby.desc)
                  ? refuted
                  : confirmed
                : call.options.phase === "Critic"
                  ? { gaps: [] }
                  : entry.name === "review-change"
                    ? { findings: [first, supporting, nearby] }
                    : { bugs: [first, supporting, nearby] },
            ),
          );
          const outcomes = decodeOutcomes(run.value);
          expect(outcomes.confirmed).toEqual([
            expect.objectContaining({
              finding: expect.objectContaining({ ...first, reports: [first, supporting] }),
              verification: confirmed,
            }),
          ]);
          expect(outcomes.refuted).toEqual([
            expect.objectContaining({
              finding: expect.objectContaining(nearby),
              verification: refuted,
            }),
          ]);
          expect(outcomes.unverified).toEqual([]);
        }
      }),
    30_000,
  );

  it.live(
    "does not equate failed or skipped finders with empty successful coverage",
    () =>
      Effect.gen(function* () {
        for (const entry of yield* reviewRecipes) {
          const run = yield* runRecipe(entry.source, entry.args, (call) =>
            Effect.succeed(call.options.phase === "Critic" ? { gaps: [] } : null),
          );
          const outcomes = decodeOutcomes(run.value);
          expect(outcomes.confirmed).toEqual([]);
          expect(outcomes.refuted).toEqual([]);
          expect(outcomes.unverified).toEqual([]);
          expect(outcomes.uncovered.length, entry.name).toBeGreaterThan(0);
        }
      }),
    30_000,
  );

  it.live(
    "preserves every assessment and leaves disagreement or a failed panel member unverified",
    () =>
      Effect.gen(function* () {
        const source = yield* fragment("**Perspective-diverse verify.**");
        for (const assessments of [
          [confirmed, refuted],
          [confirmed, null],
          [uncertain, confirmed],
          [],
        ]) {
          const run = yield* runRecipe(
            source,
            {
              claim: finding.desc,
              verificationLenses: assessments.map((_, index) => String(index)),
            },
            (call) => Effect.succeed(assessments[Number(call.options.label)] ?? null),
          );
          expect(run.value).toEqual({ claim: finding.desc, status: "unverified", assessments });
        }
      }),
    30_000,
  );

  it.live(
    "leaves plan selection open when no supported consensus exists",
    () =>
      Effect.gen(function* () {
        const source = yield* fragment("**Judge panel.**");
        const plan = {
          summary: "Guard before write",
          steps: ["Check access", "Persist"],
          risks: [],
        };
        for (const picks of [
          [],
          [null],
          [{ best: 0, why: "" }],
          [{ best: 99, why: "Invalid index" }],
          [
            { best: 0, why: "No write before guard" },
            { best: 1, why: "Better rollback" },
          ],
        ]) {
          const run = yield* runRecipe(
            source,
            {
              goal: "safe writes",
              angles: ["guard first", "rollback"],
              criteria: picks.map((_, index) => String(index)),
            },
            (call) =>
              Effect.succeed(
                call.options.phase === "Design"
                  ? plan
                  : (picks[Number(call.options.label)] ?? null),
              ),
          );
          expect(run.value).toMatchObject({ status: "unverified", picks, synthesis: null });
          expect(run.calls.some((call) => call.options.phase === "Synthesize")).toBe(false);
        }
      }),
    30_000,
  );
});

describe("adaptive exhaustive review", () => {
  it.live(
    "records only answered scopes as searched and retains a failed critic's unknown coverage",
    () =>
      Effect.gen(function* () {
        const run = yield* runRecipe(
          yield* recipe("exhaustive-review"),
          {
            ...auditArgs,
            areas: ["completed.ts", "missing.ts"],
          },
          (call) =>
            Effect.succeed(
              call.options.phase === "Critic" || call.options.label?.includes("missing.ts")
                ? null
                : { bugs: [] },
            ),
        );
        const coverage = decodeCoverage(run.value);
        expect(coverage.searched).toHaveLength(1);
        expect(coverage.searched[0]).toContain("completed.ts");
        expect(coverage.uncovered).toHaveLength(2);
        expect(coverage.uncovered).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ task: expect.stringContaining("missing.ts") }),
          ]),
        );
        expect(coverage.rounds).toBe(1);
      }),
  );

  it.live("stops on no gap but continues justified coverage even without any bugs", () =>
    Effect.gen(function* () {
      const source = yield* recipe("exhaustive-review");
      const noGap = yield* runRecipe(source, auditArgs, (call) =>
        Effect.succeed(call.options.phase === "Critic" ? { gaps: [] } : { bugs: [] }),
      );
      expect(decodeCoverage(noGap.value)).toMatchObject({ rounds: 1, uncovered: [] });
      const critics = yield* Ref.make(0);
      const gap = "Trace the auth-to-storage interaction, absent from the coverage map.";
      const run = yield* runRecipe(source, auditArgs, (call) =>
        call.options.phase === "Critic"
          ? Ref.updateAndGet(critics, (count) => count + 1).pipe(
              Effect.map((count) => ({ gaps: count === 1 ? [gap] : [] })),
            )
          : Effect.succeed({ bugs: [] }),
      );
      const coverage = decodeCoverage(run.value);
      expect(coverage.rounds).toBe(2);
      expect(coverage.searched).toContain(gap);
      expect(coverage.uncovered).toEqual([]);
    }),
  );

  it.live("stops repeated gap work rather than consuming the call backstop", () =>
    Effect.gen(function* () {
      const gap = "Trace rollback after auth changes; this interaction was not checked.";
      const run = yield* runRecipe(yield* recipe("exhaustive-review"), auditArgs, (call) =>
        Effect.succeed(call.options.phase === "Critic" ? { gaps: [gap] } : { bugs: [] }),
      );
      const coverage = decodeCoverage(run.value);
      expect(coverage.rounds).toBe(2);
      expect(coverage.uncovered).toEqual([expect.objectContaining({ task: gap })]);
      expect(run.calls.length).toBeLessThan(10);
    }),
  );

  it.live("returns unscheduled gaps when the round or budget backstop binds", () =>
    Effect.gen(function* () {
      const source = yield* recipe("exhaustive-review");
      const count = yield* Ref.make(0);
      const capped = yield* runRecipe(source, auditArgs, (call) =>
        call.options.phase === "Critic"
          ? Ref.updateAndGet(count, (n) => n + 1).pipe(
              Effect.map((n) => ({ gaps: [`Unsearched interaction ${n}`] })),
            )
          : Effect.succeed({ bugs: [] }),
      );
      const coverage = decodeCoverage(capped.value);
      expect(coverage.rounds).toBeGreaterThan(1);
      expect(capped.calls.length).toBeLessThan(20);
      expect(coverage.uncovered).toEqual([
        expect.objectContaining({ task: `Unsearched interaction ${coverage.rounds}` }),
      ]);
      const limited = yield* runRecipe(source, auditArgs, () => Effect.succeed(null), {
        budget: 1,
      });
      expect(decodeCoverage(limited.value).uncovered.length).toBeGreaterThan(0);
      expect(limited.calls).toEqual([]);
    }),
  );

  it.live("passes current evidence to the critic and rechecks later counterevidence", () =>
    Effect.gen(function* () {
      const finds = yield* Ref.make(0);
      const checks = yield* Ref.make(0);
      const critics = yield* Ref.make(0);
      const counter = {
        ...finding,
        evidence: "The alternate caller returns early; the original trace may be unreachable.",
      };
      const run = yield* runRecipe(yield* recipe("exhaustive-review"), auditArgs, (call) => {
        if (call.options.phase === "Find")
          return Ref.updateAndGet(finds, (n) => n + 1).pipe(
            Effect.map((n) => ({ bugs: [n === 1 ? finding : counter] })),
          );
        if (call.options.phase === "Verify")
          return Ref.updateAndGet(checks, (n) => n + 1).pipe(
            Effect.map((n) => (n === 1 ? confirmed : uncertain)),
          );
        return Ref.updateAndGet(critics, (n) => n + 1).pipe(
          Effect.map((n) => ({
            gaps:
              n === 1 ? ["Check the alternate caller for conflicting reachability evidence."] : [],
          })),
        );
      });
      const outcomes = decodeOutcomes(run.value);
      expect(outcomes.confirmed).toEqual([]);
      expect(outcomes.unverified).toEqual([
        expect.objectContaining({
          finding: expect.objectContaining({ reports: [finding, counter] }),
          verification: uncertain,
        }),
      ]);
      const prompts = run.calls
        .filter((call) => call.options.phase === "Critic")
        .map((call) => call.prompt);
      expect(prompts[0]).toContain(finding.evidence);
      expect(prompts[1]).toContain(counter.evidence);
      expect(prompts[1]).toContain("unverified");
    }),
  );

  it.live(
    "retains prior verification evidence after a failed recheck or contradictory assessment",
    () =>
      Effect.gen(function* () {
        const source = yield* recipe("exhaustive-review");
        for (const later of [null, refuted]) {
          const finds = yield* Ref.make(0);
          const checks = yield* Ref.make(0);
          const critics = yield* Ref.make(0);
          const counter = { ...finding, evidence: "New caller evidence requires another check." };
          const run = yield* runRecipe(source, auditArgs, (call) => {
            if (call.options.phase === "Find")
              return Ref.updateAndGet(finds, (n) => n + 1).pipe(
                Effect.map((n) => ({ bugs: [n === 1 ? finding : counter] })),
              );
            if (call.options.phase === "Verify")
              return Ref.updateAndGet(checks, (n) => n + 1).pipe(
                Effect.map((n) => (n === 1 ? confirmed : later)),
              );
            return Ref.updateAndGet(critics, (n) => n + 1).pipe(
              Effect.map((n) => ({
                gaps: n === 1 ? ["Inspect the newly discovered caller."] : [],
              })),
            );
          });
          const outcomes = decodeOutcomes(run.value);
          expect(outcomes.confirmed).toEqual([]);
          expect(outcomes.refuted).toEqual([]);
          expect(outcomes.unverified).toEqual([
            expect.objectContaining({
              verification: later,
              assessments: [confirmed, later],
            }),
          ]);
          const checksMade = run.calls.filter((call) => call.options.phase === "Verify");
          expect(checksMade[1]?.prompt).toContain(confirmed.evidence);
        }
      }),
    30_000,
  );

  it.live("keeps candidates unverified when verification has no remaining capacity", () =>
    Effect.gen(function* () {
      const run = yield* runRecipe(
        yield* recipe("exhaustive-review"),
        auditArgs,
        (call) =>
          Effect.succeed(call.options.phase === "Find" ? { bugs: [finding] } : { gaps: [] }),
        { budget: 80_000, outputTokens: 70_000 },
      );
      expect(decodeOutcomes(run.value)).toMatchObject({
        confirmed: [],
        refuted: [],
        unverified: [expect.objectContaining({ verification: null })],
      });
      expect(decodeCoverage(run.value).uncovered.length).toBeGreaterThan(0);
      expect(run.calls.every((call) => call.options.phase === "Find")).toBe(true);
    }),
  );
});
