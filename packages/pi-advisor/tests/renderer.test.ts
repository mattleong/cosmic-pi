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
            severity: "medium",
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

    expect(output).toContain("Advisor noted a concern anthropic/reviewer");
    expect(output).toContain("One material issue remains.");
    expect(output).toContain("The validation claim is unsupported.");
    expect(output).toContain("Report the actual command result.");

    const collapsed = renderer?.({ details }, { expanded: false }, theme) as {
      render(width: number): string[];
    };
    const collapsedOutput = collapsed.render(100).join("\n");
    expect(collapsedOutput).toContain("1 medium · One material issue remains.");
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
                severity: "high",
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
