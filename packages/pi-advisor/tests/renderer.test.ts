import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  registerAdvisorReviewRenderer,
  type AdvisorReviewMessageDetails,
} from "../src/renderer.ts";

describe("advisor review renderer", () => {
  test("renders the complete critique and configured model", () => {
    let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    const pi = {
      registerMessageRenderer: vi.fn((_type, nextRenderer) => {
        renderer = nextRenderer;
      }),
    } as unknown as ExtensionAPI;
    registerAdvisorReviewRenderer(pi);

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
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const component = renderer?.({ details }, { expanded: true }, theme) as {
      render(width: number): string[];
    };
    const output = component.render(100).join("\n");

    expect(output).toContain("Advisor provided advice anthropic/reviewer");
    expect(output).toContain("One material issue remains.");
    expect(output).toContain("The validation claim is unsupported.");
    expect(output).toContain("Report the actual command result.");

    const collapsed = renderer?.({ details }, { expanded: false }, theme) as {
      render(width: number): string[];
    };
    const collapsedOutput = collapsed.render(100).join("\n");
    expect(collapsedOutput).toContain("1 concern · One material issue remains.");
    expect(collapsedOutput).not.toContain("The validation claim is unsupported.");

    const guidance = renderer?.(
      { details: { ...details, action: "guidance" } },
      { expanded: false },
      theme,
    ) as { render(width: number): string[] };
    expect(guidance.render(100).join("\n")).toContain("Advisor suggested a course correction");

    const recovery = renderer?.(
      { details: { ...details, action: "recovery" } },
      { expanded: false },
      theme,
    ) as { render(width: number): string[] };
    expect(recovery.render(100).join("\n")).toContain("Advisor interrupted a stalled trajectory");
  });

  test("redacts historical reviews and configured model labels before rendering", () => {
    let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    registerAdvisorReviewRenderer({
      registerMessageRenderer: (_type: string, nextRenderer: typeof renderer) => {
        renderer = nextRenderer;
      },
    } as unknown as ExtensionAPI);

    const component = renderer?.(
      {
        details: {
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
      },
      { expanded: true },
      {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      },
    ) as { render(width: number): string[] };
    const output = component.render(120).join("\n");

    expect(output).toContain("Advisor provided advice");
    expect(output).toContain("REDACTED");
    expect(output).not.toMatch(
      /sk-abcdefghijklmnop|secret-value|abc\.def\.ghi|sk-secondsecretvalue|hunter2|another-secret-value/,
    );
  });

  test("clips oversized historical reviews before rendering", () => {
    let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    registerAdvisorReviewRenderer({
      registerMessageRenderer: (_type: string, nextRenderer: typeof renderer) => {
        renderer = nextRenderer;
      },
    } as unknown as ExtensionAPI);

    const component = renderer?.(
      {
        details: {
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
      },
      { expanded: true },
      {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      },
    ) as { render(width: number): string[] };
    const output = component.render(120).join("\n");

    expect(output).toContain("[... truncated]");
    expect(output.match(/\[CONCERN\]/g)).toHaveLength(5);
    expect(output.length).toBeLessThan(80_000);
  });

  test("expands historical findings that predate category and evidence fields", () => {
    let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    registerAdvisorReviewRenderer({
      registerMessageRenderer: (_type: string, nextRenderer: typeof renderer) => {
        renderer = nextRenderer;
      },
    } as unknown as ExtensionAPI);

    const component = renderer?.(
      {
        details: {
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
      },
      { expanded: true },
      {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      },
    ) as { render(width: number): string[] };
    const output = component.render(100).join("\n");

    expect(output).toContain("[CORRECTNESS] A legacy issue.");
    expect(output).toContain("Not recorded by this earlier advisor review.");
  });

  test("falls back to the default custom-message display for invalid details", () => {
    let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
    registerAdvisorReviewRenderer({
      registerMessageRenderer: (_type: string, nextRenderer: typeof renderer) => {
        renderer = nextRenderer;
      },
    } as unknown as ExtensionAPI);

    expect(renderer?.({ details: undefined }, {}, {})).toBeUndefined();
    expect(
      renderer?.(
        { details: { provider: "openai", model: "reviewer", review: {} } },
        {},
        {
          bold: (text: string) => text,
          fg: (_color: string, text: string) => text,
        },
      ),
    ).toBeUndefined();
  });
});
