import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { SubagentRunView } from "../../src/run/model.ts";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import type { CompactSubagentToolDetails } from "../../src/tools/details-schema.ts";
import {
  failureRecovery,
  renderCompactResultComponent,
  type SemanticOutcomeBanner,
  type SemanticRunRenderer,
} from "../../src/tools/render-management.ts";
import { view } from "./fixtures/tool-harness.ts";

// SAFETY: This fixture implements the Theme methods consumed by semantic result rendering.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

describe("failure recovery guidance", () => {
  it("gives start and action failures different guidance for the same route code", () => {
    const start = failureRecovery("profile_candidate_invalid", "Route rejected.", "start");
    const action = failureRecovery("profile_candidate_invalid", "Route rejected.", "action");
    expect(start).not.toEqual(action);
    expect(failureRecovery("profile_candidate_invalid", "Route rejected.")).toEqual(action);
  });

  it("matches message-only rules without a code and ignores the message for code-only rules", () => {
    const notFound = failureRecovery("run_not_found", "");
    expect(failureRecovery(undefined, "Run agent-9 was NOT FOUND")).toEqual(notFound);
    expect(failureRecovery(undefined, "The profile route is invalid")).toEqual(
      failureRecovery(undefined, "Something else happened"),
    );
  });

  it("falls back to context-specific generic guidance for unknown failures", () => {
    const actionFallback = failureRecovery("mystery", "unexplained", "action");
    const startFallback = failureRecovery("mystery", "unexplained", "start");
    expect(actionFallback).not.toEqual(startFallback);
    expect(failureRecovery(undefined, "", "action")).toEqual(actionFallback);
    expect(failureRecovery(undefined, "", "start")).toEqual(startFallback);
    expect(failureRecovery("run_not_found", "")).not.toEqual(actionFallback);
  });

  it("matches codes case-insensitively", () => {
    expect(failureRecovery("REPLY_TOO_LARGE", "")).toEqual(failureRecovery("reply_too_large", ""));
  });
});

describe("management outcome summaries", () => {
  const banner = (() => {
    let captured: SemanticOutcomeBanner | undefined;
    const renderRuns: SemanticRunRenderer = (_cards, _expanded, summary) => {
      captured = summary;
      return { render: () => [], invalidate: () => {} };
    };
    const summarize = (details: CompactSubagentToolDetails): SemanticOutcomeBanner => {
      // SAFETY: Only run details reach this renderer; models details never enter these assertions.
      renderCompactResultComponent(
        details as Parameters<typeof renderCompactResultComponent>[0],
        false,
        theme,
        renderRuns,
      ).render(80);
      if (!captured) throw new Error("The run renderer never received an outcome banner.");
      return captured;
    };
    return { summarize };
  })();

  it("counts listed and missing targets with neutral semantic colors", () => {
    const listed = makeCompactToolDetails({ action: "list", runs: [view(), view()] });
    expect(banner.summarize(listed)).toEqual({
      color: "accent",
      text: "2 session subagents",
    });
    const empty = makeCompactToolDetails({ action: "list", runs: [] });
    expect(banner.summarize(empty)).toEqual({ color: "accent", text: "No session subagents" });

    const found = makeCompactToolDetails({
      action: "status",
      runs: [view()],
      actionFailures: [{ id: "agent-2", code: "SubagentNotFoundError", message: "Missing." }],
    });
    expect(banner.summarize(found)).toEqual({
      color: "warning",
      text: "Status · 1 found · 1 missing",
    });
    const missing = makeCompactToolDetails({
      action: "status",
      runs: [],
      actionFailures: [{ id: "agent-2", code: "SubagentNotFoundError", message: "Missing." }],
    });
    expect(banner.summarize(missing)).toEqual({
      color: "warning",
      text: "Status · 0 found · 1 missing",
    });
  });

  it("labels guidance versus next assignments by retention and colors partial failures", () => {
    const retained = view({ closeOnReport: false });
    const guided = view();
    const details = (runs: ReadonlyArray<SubagentRunView>, failures = 0) =>
      makeCompactToolDetails({
        action: "send",
        runs,
        actionFailures:
          failures > 0
            ? Array.from({ length: failures }, (_, index) => ({
                id: `agent-f${index}`,
                code: "send_failed",
                message: "No delivery.",
              }))
            : undefined,
      });

    expect(banner.summarize(details([retained, retained]))).toEqual({
      color: "success",
      text: "Next assignments · 2 delivered",
    });
    expect(banner.summarize(details([retained, guided]))).toEqual({
      color: "success",
      text: "Guidance/next assignments · 2 delivered",
    });
    expect(banner.summarize(details([guided]))).toEqual({
      color: "success",
      text: "Guidance · 1 delivered",
    });
    expect(banner.summarize(details([guided], 1))).toEqual({
      color: "warning",
      text: "Guidance · 1 delivered · 1 failed",
    });
    expect(banner.summarize(details([], 1))).toEqual({
      color: "error",
      text: "Guidance · 0 delivered · 1 failed",
    });
  });

  it("keeps per-action delivery, lifecycle, and fallback semantics", () => {
    const details = (
      action: "reply" | "interrupt" | "resume" | "stop" | "rename" | "retry" | "claims",
      runs: ReadonlyArray<SubagentRunView>,
      failures?: ReadonlyArray<{ id: string; code: string; message: string }>,
    ) => makeCompactToolDetails({ action, runs, actionFailures: failures });

    expect(banner.summarize(details("reply", [view(), view()]))).toEqual({
      color: "success",
      text: "Reply delivered to 2 subagents",
    });
    const failure = [{ id: "agent-1", code: "reply_send_failed", message: "No channel." }];
    expect(banner.summarize(details("reply", [], failure))).toEqual({
      color: "error",
      text: "Reply failed",
    });
    expect(banner.summarize(details("interrupt", [view()]))).toEqual({
      color: "success",
      text: "Interrupt · 1 paused",
    });
    expect(banner.summarize(details("resume", [view(), view()], failure))).toEqual({
      color: "warning",
      text: "Resume · 2 updated · 1 failed",
    });
    expect(banner.summarize(details("stop", [view()]))).toEqual({
      color: "success",
      text: "Stop · 1 updated",
    });
    expect(banner.summarize(details("rename", [view()]))).toEqual({
      color: "success",
      text: "Subagent renamed",
    });
    expect(banner.summarize(details("rename", [], failure))).toEqual({
      color: "error",
      text: "Rename failed",
    });
    expect(banner.summarize(details("retry", [view()]))).toEqual({
      color: "accent",
      text: "retry · 1 result",
    });
    expect(banner.summarize(details("claims", [view(), view()], failure))).toEqual({
      color: "warning",
      text: "claims · 2 results · 1 failed",
    });
  });
});
