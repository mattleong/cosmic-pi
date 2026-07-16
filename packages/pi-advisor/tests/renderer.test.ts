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
      provider: "anthropic",
      model: "reviewer",
      review: {
        verdict: "revise",
        summary: "One material issue remains.",
        findings: [
          {
            severity: "medium",
            issue: "The validation claim is unsupported.",
            recommendation: "Report the actual command result.",
          },
        ],
      },
    };
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const component = renderer?.({ details }, { expanded: false }, theme) as {
      render(width: number): string[];
    };
    const output = component.render(100).join("\n");

    expect(output).toContain("Advisor requested a revision anthropic/reviewer");
    expect(output).toContain("One material issue remains.");
    expect(output).toContain("The validation claim is unsupported.");
    expect(output).toContain("Report the actual command result.");
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
