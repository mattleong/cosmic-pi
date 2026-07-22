import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  registerAdvisorReviewRenderer,
  type AdvisorReviewMessageDetails,
} from "../src/ui/renderer.ts";

describe("advisor review renderer", () => {
  function captureRenderer() {
    let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    registerAdvisorReviewRenderer({
      registerMessageRenderer: (_type: string, nextRenderer: typeof renderer) => {
        renderer = nextRenderer;
      },
    } as unknown as ExtensionAPI);
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    return {
      render(details: unknown, options: unknown, width = 100): string {
        const component = renderer?.({ details }, options, theme) as {
          render(width: number): string[];
        };
        return component.render(width).join("\n");
      },
      raw(message: unknown, options: unknown = {}, customTheme: unknown = theme): unknown {
        return renderer?.(message, options, customTheme);
      },
    };
  }

  test("renders the complete critique and configured model", () => {
    const { render } = captureRenderer();

    const details: AdvisorReviewMessageDetails = {
      action: "advice",
      provider: "anthropic",
      model: "reviewer",
      review: {
        verdict: "revise",
        summary: "One material issue remains.",
        findings: [
          {
            category: "evidence",
            severity: "concern",
            issue: "The validation claim is unsupported.",
            evidence: "No validation command result appears in the transcript.",
            recommendation: "Report the actual command result.",
          },
        ],
      },
    };
    const output = render(details, { expanded: true });

    expect(output).toContain("Advisor provided advice anthropic/reviewer");
    expect(output).toContain("One material issue remains.");
    expect(output).toContain("The validation claim is unsupported.");
    expect(output).toContain("Report the actual command result.");

    const collapsedOutput = render(details, { expanded: false });
    expect(collapsedOutput).toContain("1 concern · One material issue remains.");
    expect(collapsedOutput).not.toContain("The validation claim is unsupported.");

    expect(render({ ...details, action: "guidance" }, { expanded: false })).toContain(
      "Advisor suggested a course correction",
    );
    expect(render({ ...details, action: "recovery" }, { expanded: false })).toContain(
      "Advisor interrupted a stalled trajectory",
    );
  });

  test("renders optional perspective guidance separately from findings", () => {
    const { render } = captureRenderer();
    const output = render(
      {
        action: "perspective",
        provider: "openai",
        model: "reviewer",
        review: {
          verdict: "suggest",
          summary: "A simpler route may exist.",
          suggestions: [
            {
              fingerprint: "derive-state",
              kind: "simplification",
              suggestion: "Derive state from the queue.",
              rationale: "This avoids a second source of truth.",
              relevance: "likely",
            },
          ],
          findings: [],
        },
      },
      { expanded: true },
    );

    expect(output).toContain("Advisor offered a possible angle");
    expect(output).toContain("Possible angles:");
    expect(output).toContain("Derive state from the queue");
    expect(output).not.toContain("Findings:");
  });

  test("redacts historical reviews and configured model labels before rendering", () => {
    const output = captureRenderer().render(
      {
        action: "advice",
        provider: "openai-api-key=sk-abcdefghijklmnop",
        model: "reviewer-token=secret-value",
        review: {
          verdict: "revise",
          summary: "Authorization: Bearer abc.def.ghi",
          findings: [
            {
              severity: "concern",
              issue: "api_key=sk-secondsecretvalue",
              evidence: "password=hunter2",
              recommendation: "token=another-secret-value",
            },
          ],
        },
      },
      { expanded: true },
      120,
    );

    expect(output).toContain("Advisor provided advice");
    expect(output).toContain("REDACTED");
    expect(output).not.toMatch(
      /sk-abcdefghijklmnop|secret-value|abc\.def\.ghi|sk-secondsecretvalue|hunter2|another-secret-value/,
    );
  });

  test("clips oversized historical reviews before rendering", () => {
    const output = captureRenderer().render(
      {
        action: "advice",
        provider: `provider-${"p".repeat(1_000)}`,
        model: `model-${"m".repeat(1_000)}`,
        review: {
          verdict: "revise",
          summary: "s".repeat(10_000),
          findings: Array.from({ length: 20 }, (_, index) => ({
            severity: "concern",
            issue: `issue-${index}-${"i".repeat(10_000)}`,
            evidence: `evidence-${index}-${"e".repeat(10_000)}`,
            recommendation: `recommendation-${index}-${"r".repeat(10_000)}`,
          })),
        },
      },
      { expanded: true },
      120,
    );

    expect(output).toContain("[... truncated]");
    expect(output.match(/\[CONCERN\]/g)).toHaveLength(5);
    expect(output.length).toBeLessThan(80_000);
  });

  test("expands historical findings that predate category and evidence fields", () => {
    const output = captureRenderer().render(
      {
        action: "revision",
        provider: "legacy",
        model: "reviewer",
        review: {
          verdict: "revise",
          summary: "A historical review.",
          findings: [
            {
              severity: "blocker",
              issue: "A legacy issue.",
              recommendation: "Fix the legacy issue.",
            },
          ],
        },
      },
      { expanded: true },
    );

    expect(output).toContain("[CORRECTNESS] A legacy issue.");
    expect(output).toContain("Not recorded by this earlier advisor review.");
  });

  test("falls back to the default custom-message display for invalid details", () => {
    const { raw } = captureRenderer();
    expect(raw({ details: undefined })).toBeUndefined();
    expect(raw({ details: { provider: "openai", model: "reviewer", review: {} } })).toBeUndefined();
  });
});
