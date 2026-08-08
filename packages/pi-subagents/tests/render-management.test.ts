import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { SubagentRunView } from "../src/run/model.ts";
import { makeCompactToolDetails } from "../src/tools/details.ts";
import {
  failureRecovery,
  renderCompactResultComponent,
  type SemanticOutcomeBanner,
} from "../src/tools/render-management.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const view = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id: "agent-1",
  name: "auth-review",
  task: "Review auth",
  selection: {
    source: "profile-candidate",
    reason: "Profile model selection.",
    skippedCandidates: [],
  },
  cwd: "/project",
  state: "running",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  host: "local",
  runtime: "pi",
  closeOnReport: true,
  reportGeneration: 0,
  capabilities: ["steer", "interrupt"],
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  startedAt: 1,
  lastActivityAt: 1,
  sessionEvents: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  ...overrides,
});

const renderedBanner = (
  details: ReturnType<typeof makeCompactToolDetails>,
  width = 200,
): { readonly banner: SemanticOutcomeBanner; readonly lines: ReadonlyArray<string> } => {
  let captured: SemanticOutcomeBanner = { color: "accent", text: "" };
  const lines = renderCompactResultComponent(details, false, theme, (_cards, _expanded, banner) => {
    captured = banner;
    return { render: () => [banner.text], invalidate: () => {} };
  }).render(width);
  return { banner: captured, lines };
};

describe("management failure recovery", () => {
  it("gives action-specific recovery for bounded completion backlog", () => {
    expect(failureRecovery("report_delivery_backlog", "too many outcomes")).toContain(
      "subagent_await",
    );
  });

  it("never recommends retrying a reply with an uncertain delivery outcome", () => {
    expect(failureRecovery("reply_outcome_uncertain", "reply may have arrived")).toBe(
      "Do not resend the reply automatically; inspect subagent_status and wait for the run's next event.",
    );
  });

  it("explains stale question ownership without suggesting another reply", () => {
    const recovery = failureRecovery("question_ownership_mismatch", "question closed");
    expect(recovery).toContain("no longer pending");
    expect(recovery).not.toContain("subagent_reply");
  });
});

describe("management result banner", () => {
  it("renders the true run count with an omission cue when list cards are truncated", () => {
    const runs = Array.from({ length: 50 }, (_, index) => view({ id: `agent-${index + 1}` }));
    const details = makeCompactToolDetails({ action: "list", runs });
    expect(details.runCount).toBe(50);
    expect(details.cards?.length).toBe(12);
    const { banner, lines } = renderedBanner(details, 40);
    expect(banner.color).toBe("accent");
    expect(banner.text).toBe("50 session subagents");
    expect(lines.join("\n")).toContain("38 omitted");
    expect(lines.join("\n")).toContain("subagent_status");
  });

  it("does not add an omission cue when every run is rendered", () => {
    const details = makeCompactToolDetails({ action: "list", runs: [view()] });
    const { banner } = renderedBanner(details);
    expect(banner.text).toBe("1 session subagent");
    expect(banner.color).toBe("accent");
  });

  it("labels an all-retained send as next assignments", () => {
    const details = makeCompactToolDetails({
      action: "send",
      runs: [
        view({ id: "agent-r1", closeOnReport: false, host: "herdr" }),
        view({ id: "agent-r2", closeOnReport: false, host: "herdr" }),
      ],
    });
    const { banner } = renderedBanner(details);
    expect(banner.text).toBe("Next assignments · 2 delivered");
    expect(banner.color).toBe("success");
  });

  it("labels a mixed send as guidance/next assignments and keeps failure suffixes", () => {
    const details = makeCompactToolDetails({
      action: "send",
      runs: [
        view({ id: "agent-1" }),
        view({ id: "agent-r1", closeOnReport: false, host: "herdr" }),
      ],
      actionFailures: [{ id: "agent-x", code: "not_running", message: "agent-x is paused" }],
    });
    const { banner, lines } = renderedBanner(details);
    expect(banner.text).toBe("Guidance/next assignments · 2 delivered · 1 failed");
    expect(lines.join("\n")).toContain("agent-x [not_running]");
  });

  it("keeps the plain guidance label for a send without retained targets", () => {
    const details = makeCompactToolDetails({ action: "send", runs: [view()] });
    const { banner } = renderedBanner(details);
    expect(banner.text).toBe("Guidance · 1 delivered");
  });
});
