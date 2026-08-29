import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { describe, expect, it, test } from "@effect/vitest";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "pi-cosmic-core/testing";
import { classifyFailure } from "../src/application/controller-helpers.ts";
import {
  MAX_ADVISOR_EVIDENCE_CHARS,
  MAX_ADVISOR_FINDINGS,
  MAX_ADVISOR_FINGERPRINT_CHARS,
  MAX_ADVISOR_ISSUE_CHARS,
  MAX_ADVISOR_RATIONALE_CHARS,
  MAX_ADVISOR_RECOMMENDATION_CHARS,
  MAX_ADVISOR_REVIEW_CHARS,
  MAX_ADVISOR_SUGGESTION_CHARS,
  MAX_ADVISOR_SUGGESTIONS,
  MAX_ADVISOR_SUMMARY_CHARS,
} from "../src/review/schema.ts";
import { AdvisorModelError } from "../src/runtime/client.ts";
import {
  AdvisorRuntimeResetRequiredError,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  MAX_ADVISOR_CHECKPOINT_ID_CHARS,
  MAX_ADVISOR_STATE_SUMMARY_CHARS,
  parseAdvisorCheckpointEffect,
  type AdvisorCheckpoint,
} from "../src/runtime/runtime.ts";

interface SuggestionFixture {
  readonly fingerprint: string;
  readonly kind: string;
  readonly suggestion: string;
  readonly rationale: string;
  readonly relevance: string;
  readonly extra?: boolean;
}

interface FindingFixture {
  readonly fingerprint: string;
  readonly category: string;
  readonly severity: string;
  readonly confidence: string;
  readonly evidenceBasis: string;
  readonly issue: string;
  readonly evidence: string;
  readonly recommendation: string;
  readonly extra?: boolean;
}

interface CheckpointFixture {
  readonly checkpointId: string;
  readonly processedThrough: number;
  readonly stateSummary: string;
  readonly verdict: string;
  readonly summary: string;
  readonly suggestions: ReadonlyArray<SuggestionFixture>;
  readonly findings: ReadonlyArray<FindingFixture>;
  readonly extra?: boolean;
  readonly unexpected?: string;
}

const suggestion = (overrides: Partial<SuggestionFixture> = {}): SuggestionFixture => ({
  fingerprint: "derive-state-from-queue",
  kind: "simplification",
  suggestion: "Derive pending state from the queue.",
  rationale: "This avoids synchronized mutable state.",
  relevance: "likely",
  ...overrides,
});

const finding = (overrides: Partial<FindingFixture> = {}): FindingFixture => ({
  fingerprint: "unsupported-test-claim",
  category: "evidence",
  severity: "blocker",
  confidence: "high",
  evidenceBasis: "direct",
  issue: "The answer claims tests passed without evidence.",
  evidence: "No test command result appears in the transcript.",
  recommendation: "Report the actual result or remove the claim.",
  ...overrides,
});

const checkpoint = (overrides: Partial<CheckpointFixture> = {}): CheckpointFixture => ({
  checkpointId: "checkpoint-1",
  processedThrough: 0,
  stateSummary: "compact state",
  verdict: "pass",
  summary: "No material issue.",
  suggestions: [],
  findings: [],
  ...overrides,
});

const rawCheckpoint = (overrides: Partial<CheckpointFixture> = {}): string =>
  JSON.stringify(checkpoint(overrides));

function decode(raw: string): AdvisorCheckpoint {
  return Effect.runSync(parseAdvisorCheckpointEffect(raw));
}

function decodeFailure(raw: string): AdvisorModelError {
  const exit = Effect.runSyncExit(parseAdvisorCheckpointEffect(raw));
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Success") throw new Error("Expected checkpoint decoding to fail.");
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag === "None") throw new Error("Expected a typed checkpoint failure.");
  expect(Cause.hasDies(exit.cause)).toBe(false);
  expect(failure.value).toBeInstanceOf(AdvisorModelError);
  if (!(failure.value instanceof AdvisorModelError)) {
    throw new Error("Expected AdvisorModelError.");
  }
  return failure.value;
}

function expectOrdinaryResponseFormat(raw: string): AdvisorModelError {
  const error = decodeFailure(raw);
  expect(error).not.toBeInstanceOf(AdvisorRuntimeResetRequiredError);
  expect(error.kind).toBe("response-format");
  expect(error.message).toBe("Advisor checkpoint response format is invalid.");
  return error;
}

function expectResetRequiredResponseFormat(raw: string): AdvisorRuntimeResetRequiredError {
  const error = decodeFailure(raw);
  expect(error).toBeInstanceOf(AdvisorRuntimeResetRequiredError);
  expect(error.kind).toBe("response-format");
  expect(error.message).toBe("Advisor checkpoint response format requires a fresh context.");
  if (!(error instanceof AdvisorRuntimeResetRequiredError)) {
    throw new Error("Expected AdvisorRuntimeResetRequiredError.");
  }
  return error;
}

const reviewOnly = (value: CheckpointFixture) => ({
  verdict: value.verdict,
  summary: value.summary,
  suggestions: value.suggestions,
  findings: value.findings,
});

describe("checkpoint response Schema", () => {
  test.each([
    ["pass", checkpoint()],
    [
      "suggest",
      checkpoint({
        verdict: "suggest",
        summary: "Another approach may help.",
        suggestions: [suggestion()],
      }),
    ],
    [
      "revise",
      checkpoint({
        verdict: "revise",
        summary: "A correction is required.",
        findings: [finding()],
      }),
    ],
  ])("accepts the %s lane", (_lane, value) => {
    expect(decode(JSON.stringify(value))).toMatchObject(value);
  });

  test.each([
    ["pass with a suggestion", { verdict: "pass", suggestions: [suggestion()] }],
    ["pass with a finding", { verdict: "pass", findings: [finding()] }],
    ["suggest without a suggestion", { verdict: "suggest" }],
    [
      "suggest with a finding",
      { verdict: "suggest", suggestions: [suggestion()], findings: [finding()] },
    ],
    ["revise without a finding", { verdict: "revise" }],
    [
      "revise with a suggestion",
      { verdict: "revise", suggestions: [suggestion()], findings: [finding()] },
    ],
  ])("rejects %s", (_label, overrides) => {
    expectOrdinaryResponseFormat(rawCheckpoint(overrides));
  });

  test("trims every review string while preserving checkpoint ID whitespace", () => {
    const suggested = decode(
      rawCheckpoint({
        checkpointId: "  exact checkpoint ID  ",
        verdict: "suggest",
        summary: "  Useful angle.  ",
        suggestions: [
          suggestion({
            fingerprint: "  stable-key  ",
            suggestion: "  Try the queue.  ",
            rationale: "  It already owns ordering.  ",
          }),
        ],
      }),
    );
    expect(suggested.checkpointId).toBe("  exact checkpoint ID  ");
    expect(suggested.summary).toBe("Useful angle.");
    expect(suggested.suggestions[0]).toMatchObject({
      fingerprint: "stable-key",
      suggestion: "Try the queue.",
      rationale: "It already owns ordering.",
    });

    const revised = decode(
      rawCheckpoint({
        verdict: "revise",
        summary: "  Needs correction.  ",
        findings: [
          finding({
            fingerprint: "  stable-finding  ",
            issue: "  Wrong result.  ",
            evidence: "  Output differs.  ",
            recommendation: "  Correct it.  ",
          }),
        ],
      }),
    );
    expect(revised.findings[0]).toMatchObject({
      fingerprint: "stable-finding",
      issue: "Wrong result.",
      evidence: "Output differs.",
      recommendation: "Correct it.",
    });
  });

  test("accepts a nonempty whitespace checkpoint ID without normalizing it", () => {
    expect(decode(rawCheckpoint({ checkpointId: "   " })).checkpointId).toBe("   ");
    expectOrdinaryResponseFormat(rawCheckpoint({ checkpointId: "" }));
    expectOrdinaryResponseFormat(
      rawCheckpoint({ checkpointId: "x".repeat(MAX_ADVISOR_CHECKPOINT_ID_CHARS + 1) }),
    );
  });

  test("redacts state summary after validating its raw size", () => {
    const value = decode(
      rawCheckpoint({
        stateSummary: "api_key=sk-abcdefghijklmnop and Bearer abc.def.ghi",
      }),
    );
    expect(value.stateSummary).toContain("REDACTED");
    expect(value.stateSummary).not.toMatch(/sk-abcdefghijklmnop|abc\.def\.ghi/);

    const compressibleSecret = `api_key=${"a".repeat(MAX_ADVISOR_STATE_SUMMARY_CHARS)}`;
    expect(compressibleSecret.length).toBeGreaterThan(MAX_ADVISOR_STATE_SUMMARY_CHARS);
    expectResetRequiredResponseFormat(rawCheckpoint({ stateSummary: compressibleSecret }));
  });

  test("does not reapply the raw state bound after redaction", () => {
    const rawState = Array.from({ length: 190 }, () => "sk-abcdefghijkl").join(" ");
    expect(rawState.length).toBeLessThanOrEqual(MAX_ADVISOR_STATE_SUMMARY_CHARS);
    const decoded = decode(rawCheckpoint({ stateSummary: rawState }));
    expect(decoded.stateSummary.length).toBeGreaterThan(MAX_ADVISOR_STATE_SUMMARY_CHARS);
    expect(decoded.stateSummary).not.toContain("sk-abcdefghijkl");
  });

  test.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts natural processedThrough %s", (value) => {
    expect(decode(rawCheckpoint({ processedThrough: value })).processedThrough).toBe(value);
  });

  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-natural processedThrough %s",
    (value) => {
      expectOrdinaryResponseFormat(rawCheckpoint({ processedThrough: value }));
    },
  );

  test("enforces the raw checkpoint gate", () => {
    expectResetRequiredResponseFormat("x".repeat(MAX_ADVISOR_CHECKPOINT_CHARS + 1));
  });

  test("enforces the embedded review gate before trimming or lane checks", () => {
    const findings = Array.from({ length: MAX_ADVISOR_FINDINGS }, (_, index) =>
      finding({
        fingerprint: `finding-${index}`.padEnd(MAX_ADVISOR_FINGERPRINT_CHARS, "f"),
        issue: "i".repeat(MAX_ADVISOR_ISSUE_CHARS),
        evidence: "e".repeat(MAX_ADVISOR_EVIDENCE_CHARS),
        recommendation: "r".repeat(MAX_ADVISOR_RECOMMENDATION_CHARS),
      }),
    );
    const suggestions = Array.from({ length: MAX_ADVISOR_SUGGESTIONS }, (_, index) =>
      suggestion({
        fingerprint: `suggestion-${index}`.padEnd(MAX_ADVISOR_FINGERPRINT_CHARS, "s"),
        suggestion: "s".repeat(MAX_ADVISOR_SUGGESTION_CHARS),
        rationale: "r".repeat(MAX_ADVISOR_RATIONALE_CHARS),
      }),
    );
    const value = checkpoint({
      verdict: "revise",
      summary: "m".repeat(MAX_ADVISOR_SUMMARY_CHARS),
      suggestions,
      findings,
    });
    const embeddedLength = JSON.stringify(reviewOnly(value)).length;
    const raw = JSON.stringify(value);
    expect(embeddedLength).toBeGreaterThan(MAX_ADVISOR_REVIEW_CHARS);
    expect(raw.length).toBeLessThanOrEqual(MAX_ADVISOR_CHECKPOINT_CHARS);
    expectResetRequiredResponseFormat(raw);
  });

  test.each([
    ["summary", () => checkpoint({ summary: "x".repeat(MAX_ADVISOR_SUMMARY_CHARS + 1) })],
    [
      "suggestion fingerprint",
      () =>
        checkpoint({
          verdict: "suggest",
          suggestions: [suggestion({ fingerprint: "x".repeat(MAX_ADVISOR_FINGERPRINT_CHARS + 1) })],
        }),
    ],
    [
      "suggestion",
      () =>
        checkpoint({
          verdict: "suggest",
          suggestions: [suggestion({ suggestion: "x".repeat(MAX_ADVISOR_SUGGESTION_CHARS + 1) })],
        }),
    ],
    [
      "rationale",
      () =>
        checkpoint({
          verdict: "suggest",
          suggestions: [suggestion({ rationale: "x".repeat(MAX_ADVISOR_RATIONALE_CHARS + 1) })],
        }),
    ],
    [
      "finding fingerprint",
      () =>
        checkpoint({
          verdict: "revise",
          findings: [finding({ fingerprint: "x".repeat(MAX_ADVISOR_FINGERPRINT_CHARS + 1) })],
        }),
    ],
    [
      "issue",
      () =>
        checkpoint({
          verdict: "revise",
          findings: [finding({ issue: "x".repeat(MAX_ADVISOR_ISSUE_CHARS + 1) })],
        }),
    ],
    [
      "evidence",
      () =>
        checkpoint({
          verdict: "revise",
          findings: [finding({ evidence: "x".repeat(MAX_ADVISOR_EVIDENCE_CHARS + 1) })],
        }),
    ],
    [
      "recommendation",
      () =>
        checkpoint({
          verdict: "revise",
          findings: [finding({ recommendation: "x".repeat(MAX_ADVISOR_RECOMMENDATION_CHARS + 1) })],
        }),
    ],
  ])("rejects an oversized raw %s", (_label, makeValue) => {
    expectOrdinaryResponseFormat(JSON.stringify(makeValue()));
  });

  test("applies string bounds before trimming", () => {
    expectOrdinaryResponseFormat(
      rawCheckpoint({ summary: `${" ".repeat(MAX_ADVISOR_SUMMARY_CHARS)}x` }),
    );
    expectOrdinaryResponseFormat(
      rawCheckpoint({
        verdict: "revise",
        findings: [finding({ evidence: `${" ".repeat(MAX_ADVISOR_EVIDENCE_CHARS)}x` })],
      }),
    );
  });

  test.each([
    ["extra root key", checkpoint({ extra: true })],
    [
      "extra suggestion key",
      checkpoint({ verdict: "suggest", suggestions: [suggestion({ extra: true })] }),
    ],
    ["extra finding key", checkpoint({ verdict: "revise", findings: [finding({ extra: true })] })],
  ])("rejects an exact-key violation at %s", (_label, value) => {
    expectOrdinaryResponseFormat(JSON.stringify(value));
  });

  test("requires suggestions even when the lane is pass", () => {
    const { suggestions: _suggestions, ...missing } = checkpoint();
    expectOrdinaryResponseFormat(JSON.stringify(missing));
  });

  test("enforces suggestion and finding counts", () => {
    expectOrdinaryResponseFormat(
      rawCheckpoint({
        verdict: "suggest",
        suggestions: Array.from({ length: MAX_ADVISOR_SUGGESTIONS + 1 }, (_, index) =>
          suggestion({ fingerprint: `suggestion-${index}` }),
        ),
      }),
    );
    expectOrdinaryResponseFormat(
      rawCheckpoint({
        verdict: "revise",
        findings: Array.from({ length: MAX_ADVISOR_FINDINGS + 1 }, (_, index) =>
          finding({ fingerprint: `finding-${index}` }),
        ),
      }),
    );
  });

  test("requires nonempty canonical fingerprints and uniqueness", () => {
    expectOrdinaryResponseFormat(
      rawCheckpoint({ verdict: "suggest", suggestions: [suggestion({ fingerprint: "!!!" })] }),
    );
    expectOrdinaryResponseFormat(
      rawCheckpoint({
        verdict: "revise",
        findings: [
          finding({ fingerprint: "Unsupported_Test Claim" }),
          finding({ fingerprint: " unsupported-test-claim ", issue: "Another issue." }),
        ],
      }),
    );
    expectOrdinaryResponseFormat(
      rawCheckpoint({
        verdict: "revise",
        suggestions: [suggestion({ fingerprint: "same-key" })],
        findings: [finding({ fingerprint: "SAME_key" })],
      }),
    );
  });

  test.each([
    ["empty input", ""],
    ["malformed JSON", "{"],
    ["fenced JSON", `\`\`\`json\n${rawCheckpoint()}\n\`\`\``],
    ["prose around JSON", `Here is the checkpoint:\n${rawCheckpoint()}`],
  ])("rejects %s without a standalone review parser", (_label, raw) => {
    expectResetRequiredResponseFormat(raw);
  });
});

describe("checkpoint decode failures", () => {
  test("uses reset-required only for the four recovery categories", () => {
    const oversizedReview = checkpoint({
      verdict: "revise",
      summary: "m".repeat(MAX_ADVISOR_SUMMARY_CHARS),
      suggestions: Array.from({ length: MAX_ADVISOR_SUGGESTIONS }, (_, index) =>
        suggestion({
          fingerprint: `suggestion-${index}`,
          suggestion: "s".repeat(MAX_ADVISOR_SUGGESTION_CHARS),
          rationale: "r".repeat(MAX_ADVISOR_RATIONALE_CHARS),
        }),
      ),
      findings: Array.from({ length: MAX_ADVISOR_FINDINGS }, (_, index) =>
        finding({
          fingerprint: `finding-${index}`,
          issue: "i".repeat(MAX_ADVISOR_ISSUE_CHARS),
          evidence: "e".repeat(MAX_ADVISOR_EVIDENCE_CHARS),
          recommendation: "r".repeat(MAX_ADVISOR_RECOMMENDATION_CHARS),
        }),
      ),
    });
    for (const raw of [
      "x".repeat(MAX_ADVISOR_CHECKPOINT_CHARS + 1),
      "malformed checkpoint JSON",
      JSON.stringify(oversizedReview),
      rawCheckpoint({ stateSummary: "x".repeat(MAX_ADVISOR_STATE_SUMMARY_CHARS + 1) }),
    ]) {
      expectResetRequiredResponseFormat(raw);
    }

    for (const raw of [
      rawCheckpoint({ verdict: "revise" }),
      rawCheckpoint({ processedThrough: -1 }),
      rawCheckpoint({ summary: " " }),
      rawCheckpoint({ checkpointId: "" }),
      rawCheckpoint({ unexpected: "field" }),
    ]) {
      expectOrdinaryResponseFormat(raw);
    }
  });

  test("classifies typed response-format failures without message heuristics", () => {
    expect(
      classifyFailure(
        new AdvisorModelError({ message: "opaque fixed failure", kind: "response-format" }),
      ),
    ).toBe("response-format");
    expect(
      classifyFailure(
        new AdvisorRuntimeResetRequiredError({
          message: "opaque fixed reset",
          kind: "response-format",
        }),
      ),
    ).toBe("response-format");
  });

  it.effect("does not retain raw input or Schema issues in errors or spans", () =>
    Effect.gen(function* () {
      const captured = makeCapturedTracer();
      const secrets = ["sk-secret-value", "/secret/path", "acct_hidden"];
      const raw = `not json ${secrets.join(" ")}`;
      const exit = yield* Effect.exit(
        parseAdvisorCheckpointEffect(raw).pipe(provideBuiltLayer(captured.layer)),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(AdvisorRuntimeResetRequiredError);
          if (!(failure.value instanceof AdvisorRuntimeResetRequiredError)) {
            throw new Error("Expected AdvisorRuntimeResetRequiredError.");
          }
          expect("issue" in failure.value).toBe(false);
          expect(failure.value.cause).toBeUndefined();
          const serialized = String(failure.value);
          expect(serialized).not.toContain("SchemaError");
          for (const secret of secrets) expect(serialized).not.toContain(secret);
        }
        expect(Cause.hasDies(exit.cause)).toBe(false);
      }
      expect(captured.spans.map((span) => span.name)).toContain("pi-advisor.checkpoint.decode");
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(telemetry).not.toContain("SchemaError");
      expect(telemetry).not.toContain("InvalidValue");
      for (const secret of secrets) expect(telemetry).not.toContain(secret);
    }),
  );
});
