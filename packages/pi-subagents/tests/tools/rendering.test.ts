// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emptyUsage, type SubagentRunView } from "../../src/run/model.ts";
import { formatRun } from "../../src/tools/output.ts";
import { type SubagentAwaitUntil } from "../../src/run/service.ts";
import { makeCompactToolDetails, makeStartAwaitCardDetails } from "../../src/tools/details.ts";
import {
  renderAwaitProgressComponent,
  type SubagentToolRenderContext,
} from "../../src/tools/render-await.ts";
import {
  awaitResultBanner,
  renderExpandedStartAwaitResult,
  renderStartAwaitOverviewComponent,
} from "../../src/tools/render.ts";
import {
  captureSubagentTools,
  context,
  fallbackProfileService,
  profileServiceFor,
  startCapturingService,
  view,
} from "./fixtures/tool-harness.ts";
import { subagentServiceFixture } from "../fixtures/pi-host.ts";

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  it("summarizes tool calls with user-facing actions and bounded task or message context", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const tools = captureSubagentTools(subagentServiceFixture({}));
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const rendered = <Args>(name: string, args: Args, expanded = false): string => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const component = tools.get(name)?.renderCall?.(args, theme, { expanded } as never) as
        | { readonly render: (width: number) => ReadonlyArray<string> }
        | undefined;
      return component?.render(240).join("\n") ?? "";
    };

    const startArgs = {
      agents: [{ name: "auth-review", profile: "reviewer", task: "Review token refresh" }],
    };
    expect(rendered("subagent_start", startArgs)).toContain(
      "Start 1 subagent auth-review [reviewer]",
    );
    expect(rendered("subagent_start", startArgs)).not.toContain("Review token refresh");
    expect(rendered("subagent_start", startArgs, true)).toContain("Task: Review token refresh");
    expect(
      rendered("subagent_await", { runIds: ["agent-1", "agent-2"], until: "all_finished" }),
    ).toContain("Await 2 subagents until all finish · agent-1, agent-2");
    expect(
      rendered("subagent_send", { runIds: ["agent-1"], message: "Check migration tests" }),
    ).toContain("Guide 1 subagent agent-1 · “Check migration tests”");
    expect(
      rendered("subagent_reply", { runId: "agent-1", message: "Use the existing fixture" }),
    ).toContain("Reply to subagent agent-1 · “Use the existing fixture”");
    expect(
      rendered("subagent_lifecycle", {
        action: "resume",
        runIds: ["agent-1"],
        message: "Continue from the report",
      }),
    ).toContain("Resume 1 subagent agent-1 · “Continue from the report”");
    expect(rendered("subagent_models", { profile: "reviewer" })).toContain(
      "Inspect profile routes reviewer",
    );
    expect(rendered("subagent_send", { runIds: ["agent-1"], message: "x".repeat(500) })).toContain(
      "… [truncated]",
    );
  });

  it("does not let caller-owned fields override a focused tool action", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const models = await captureSubagentTools(subagentServiceFixture({}))
      .get("subagent_models")
      ?.execute("call", { action: "start", profile: "scout" }, undefined, undefined, context);
    expect(models?.details).toMatchObject({ action: "models", profileIds: ["scout"] });
    expect(models?.content[0]?.text).toContain("scout —");
    expect(models?.content[0]?.text).toContain("source=builtin · defaults: context=fresh");
  });

  it("renders profile routes and management outcomes from structured persisted details", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const tools = captureSubagentTools(subagentServiceFixture({}));
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    } as Theme;
    const models = await tools
      .get("subagent_models")
      ?.execute("call", { profile: "reviewer" }, undefined, undefined, context);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const modelCard = tools
      .get("subagent_models")
      ?.renderResult?.(models!, { isPartial: false, expanded: true }, theme) as
      | { readonly render: (width: number) => ReadonlyArray<string> }
      | undefined;
    const modelText = modelCard?.render(160).join("\n") ?? "";
    expect(modelText).toContain("Profile routes · static eligibility only · fallback generalist");
    expect(modelText).toContain("reviewer · built-in");
    expect(modelText).toContain("close after report");
    expect(modelText).toContain("Launch checks pending");

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const fastProfileTools = captureSubagentTools(
      subagentServiceFixture({}),
      ["read"],
      profileServiceFor({
        profiles: {
          reviewer: {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "default",
            context: "fresh",
            writeIntent: "read-only",
            fastMode: true,
          },
        },
      }),
    );
    const fastModels = await fastProfileTools
      .get("subagent_models")
      ?.execute("call", { profile: "reviewer" }, undefined, undefined, context);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const fastModelCard = fastProfileTools
      .get("subagent_models")
      ?.renderResult?.(fastModels!, { isPartial: false, expanded: true }, theme) as
      | { readonly render: (width: number) => ReadonlyArray<string> }
      | undefined;
    expect(fastModelCard?.render(160).join("\n")).toContain("local/pi · parent:default ⚡");

    const management = makeCompactToolDetails({
      action: "send",
      runs: [view({ id: "agent-1", name: "auth-review", state: "running" })],
      actionFailures: [
        { id: "missing-agent", code: "SubagentNotFoundError", message: "Run not found." },
      ],
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const managementCard = tools
      .get("subagent_send")
      ?.renderResult?.(
        { content: [{ type: "text", text: "fallback acknowledgement" }], details: management },
        { isPartial: false, expanded: false },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    const managementText = managementCard?.render(160).join("\n") ?? "";
    expect(managementText).toContain("Guidance · 1 delivered · 1 failed");
    expect(managementText).toContain("auth-review · agent-1");
    expect(managementText).toContain("Refresh run IDs with subagent_list");

    const pausedDetails = makeCompactToolDetails({
      action: "list",
      runs: [view({ state: "paused", capabilities: [] })],
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const pausedCard = tools
      .get("subagent_list")
      ?.renderResult?.(
        { content: [{ type: "text", text: "paused" }], details: pausedDetails },
        { isPartial: false, expanded: false },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(pausedCard?.render(160).join("\n")).toContain(
      "cannot resume · stop it and start a replacement",
    );

    // Absent capability evidence renders neutral guidance rather than a
    // definite cannot-resume claim.
    const { capabilities: _omittedCapabilities, ...pausedWithoutCapabilities } = view({
      state: "paused",
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const unknownCapabilityDetails = makeCompactToolDetails({
      action: "list",
      runs: [pausedWithoutCapabilities as SubagentRunView],
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const unknownCapabilityCard = tools
      .get("subagent_list")
      ?.renderResult?.(
        { content: [{ type: "text", text: "paused" }], details: unknownCapabilityDetails },
        { isPartial: false, expanded: false },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    const unknownCapabilityText = unknownCapabilityCard?.render(160).join("\n") ?? "";
    expect(unknownCapabilityText).toContain("check resume support with subagent_status");
    expect(unknownCapabilityText).not.toContain("cannot resume");

    const statusDetails = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "completed", finalText: "## Summary\nEverything passed." })],
      includeReports: true,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const statusCard = tools
      .get("subagent_status")
      ?.renderResult?.(
        { content: [{ type: "text", text: "status fallback" }], details: statusDetails },
        { isPartial: false, expanded: true },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(statusCard?.render(160).join("\n")).toContain("Report 1 of 1 — auth-review");
  });

  it("color-codes agent names by state while await is in progress", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as Theme;
    const progress = (runs: ReadonlyArray<SubagentRunView>, until: SubagentAwaitUntil) =>
      renderAwaitProgressComponent(runs, until, theme).render(120).join("\n");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const rendered = progress(
        [
          view({ id: "agent-1", name: "running-agent", state: "running" }),
          view({ id: "agent-2", name: "waiting-agent", state: "waiting_for_parent" }),
          view({ id: "agent-3", name: "failed-agent", state: "failed" }),
          view({ id: "agent-4", name: "stopped-agent", state: "stopped" }),
        ],
        "all_finished",
      );

      expect(rendered).toContain(
        "<error>Waiting for all subagents · 2 of 4 subagents finished · 1 running · 1 waiting for reply</error>",
      );
      expect(rendered).toContain("<success>⠋ running-agent · agent-1</success>");
      expect(rendered).toContain("<warning>? waiting-agent · agent-2</warning>");
      expect(rendered).toContain("<warning>waiting for reply</warning>");
      expect(rendered).toContain(
        "<toolOutput>local/pi · openai-codex/gpt-5.6-sol:high</toolOutput>",
      );
      expect(rendered).toContain("<error>✗ failed-agent · agent-3</error>");
      expect(rendered).toContain("<muted>⊘ stopped-agent · agent-4</muted>");
      expect(progress([view({ state: "running" })], "any_finished")).toContain(
        "Waiting for first subagent · 0 of 1 subagents finished · 1 running",
      );
      expect(progress([view({ state: "completed" })], "all_finished")).toContain(
        "<success>1 subagent finished</success>",
      );
      expect(
        progress(
          [view({ state: "reported", reportGeneration: 2, closeOnReport: false })],
          "all_finished",
        ),
      ).toContain("<success>1 subagent finished</success>");
      expect(progress([view({ state: "running" })], "all_finished")).toContain(
        "<success>⠋ auth-review · agent-1</success>",
      );
      vi.setSystemTime(320);
      expect(progress([view({ state: "running" })], "all_finished")).toContain(
        "<success>⠹ auth-review · agent-1</success>",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows bounded elapsed activity and humanized aggregate usage", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Theme;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(11_000);
      const rendered = renderAwaitProgressComponent(
        [
          view({
            state: "running",
            startedAt: 1_000,
            lastActivityAt: 9_000,
            usage: {
              input: 10_000,
              output: 8_400,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 18_400,
              cost: 0.042,
            },
          }),
        ],
        "all_finished",
        theme,
      )
        .render(120)
        .join("\n");
      expect(rendered).toContain("Total usage · 18k tokens · $0.04");
      expect(rendered).toContain("running · 10s · active 2s ago");
      expect(rendered).toContain("18k tok · $0.04");
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns a repaint ticker while partial await cards contain animated runs", () => {
    let tick: (() => void) | undefined;
    const stop = vi.fn();
    const startUiTicker = vi.fn((_intervalMs: number, next: () => void) => {
      tick = next;
      return stop;
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const awaitTool = captureSubagentTools(
      subagentServiceFixture({}),
      ["read"],
      fallbackProfileService,
      undefined,
      { cwd: "/project", projectTrusted: true },
      "high",
      startUiTicker,
    ).get("subagent_await");
    const invalidate = vi.fn();
    const state: SubagentToolRenderContext["state"] = {};
    const renderContext = {
      args: { runIds: ["agent-1"], until: "all_finished" },
      toolCallId: "await-call",
      invalidate,
      lastComponent: undefined,
      state,
      cwd: "/project",
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    };
    const runningDetails = makeStartAwaitCardDetails({
      action: "await",
      runs: [view()],
      awaitUntil: "all_finished",
    });
    const partial = { content: [{ type: "text", text: "Waiting" }], details: runningDetails };
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;

    awaitTool?.renderResult?.(partial, { expanded: false, isPartial: true }, theme, renderContext);
    awaitTool?.renderResult?.(partial, { expanded: false, isPartial: true }, theme, renderContext);

    expect(startUiTicker).toHaveBeenCalledOnce();
    expect(startUiTicker).toHaveBeenCalledWith(160, expect.any(Function));
    tick?.();
    expect(invalidate).toHaveBeenCalledOnce();

    awaitTool?.renderResult?.(
      {
        content: [{ type: "text", text: "Cancelled" }],
        details: makeStartAwaitCardDetails({
          action: "await",
          runs: [view()],
          awaitUntil: "all_finished",
          cancelled: true,
        }),
      },
      { expanded: false, isPartial: true },
      theme,
      renderContext,
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(state.piSubagentsAwaitTicker).toBeUndefined();
    expect(state.piSubagentsAwaitInvalidate).toBeUndefined();
  });

  it("renders partial batch starts as structured run cards", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startTool = captureSubagentTools(subagentServiceFixture({})).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    } as Theme;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const component = startTool?.renderResult?.(
      {
        content: [{ type: "text", text: "Started 1 of 3 background subagents." }],
        details: makeStartAwaitCardDetails({
          action: "start",
          runs: [view({ name: "scout-one" })],
        }),
      },
      { expanded: false, isPartial: true },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const rendered = component?.render(100).join("\n") ?? "";
    expect(rendered).toContain("Started 1 of 3");
    expect(rendered).toContain("<success>✓</success> <toolTitle>scout-one</toolTitle>");
    expect(rendered).toContain("<muted>generalist</muted>");
    expect(rendered).toContain("<toolOutput>local/pi · openai-codex/gpt-5.6-sol:high</toolOutput>");
    expect(rendered).toContain("<muted>agent-1</muted>");
  });

  it("keeps partial batch-start outcomes in requested order, including pending launches", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startTool = captureSubagentTools(subagentServiceFixture({})).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const component = startTool?.renderResult?.(
      {
        content: [{ type: "text", text: "fallback progress" }],
        details: makeStartAwaitCardDetails({
          action: "start",
          runs: [view({ id: "agent-2", name: "second-started" })],
          startEntries: [
            {
              index: 0,
              name: "first-pending",
              profile: "scout",
              status: "pending",
              routeStatus: "resolving",
            },
            {
              index: 1,
              name: "second-started",
              profile: "reviewer",
              status: "started",
              routeStatus: "selected",
              host: "local",
              runtime: "pi",
              model: "openai-codex/gpt-5.6-sol",
              effort: "high",
              runId: "agent-2",
            },
            {
              index: 2,
              name: "third-failed",
              profile: "worker",
              status: "failed",
              routeStatus: "unavailable",
            },
          ],
          startFailures: [{ index: 2, name: "third-failed", message: "No route" }],
        }),
      },
      { expanded: false, isPartial: true },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const rendered = component?.render(120).join("\n") ?? "";
    expect(rendered).toContain("Launching 2 of 3 · 1 started · 1 failed · 1 pending");
    expect(rendered.indexOf("first-pending")).toBeLessThan(rendered.indexOf("second-started"));
    expect(rendered.indexOf("second-started")).toBeLessThan(rendered.indexOf("third-failed"));

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const expanded = startTool?.renderResult?.(
      {
        content: [{ type: "text", text: "fallback progress" }],
        details: makeStartAwaitCardDetails({
          action: "start",
          runs: [],
          startEntries: [
            {
              index: 0,
              name: "failed-expanded",
              profile: "reviewer",
              status: "failed",
              routeStatus: "unavailable",
            },
          ],
          startFailures: [
            { index: 0, name: "failed-expanded", code: "no_route", message: "No route" },
          ],
        }),
      },
      { expanded: true, isPartial: true },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const expandedText = expanded?.render(100).join("\n") ?? "";
    expect(expandedText).toContain("Failure — failed-expanded [no_route]");
    expect(expandedText).toContain("No route");
    expect(expandedText).not.toContain("expand to view");
  });

  it("renders final starts as ordered immutable receipts with profile and route/model", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startTool = captureSubagentTools(subagentServiceFixture({})).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: [
        view({
          id: "agent-very-secret-1",
          name: "auth-review",
          profile: "reviewer",
          currentTool: "stale-tool",
          progress: "stale progress",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        }),
      ],
      startEntries: [
        {
          index: 0,
          name: "auth-review",
          profile: "reviewer",
          status: "started",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "high",
          candidateIndex: 1,
          runId: "agent-very-secret-1",
        },
        {
          index: 1,
          name: "docs-review",
          profile: "scout",
          status: "failed",
          routeStatus: "unavailable",
        },
      ],
      startFailures: [
        {
          index: 1,
          name: "docs-review",
          code: "profile_no_eligible_model",
          message: "No eligible candidate remained.",
        },
      ],
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const collapsed = startTool?.renderResult?.(
      { content: [{ type: "text", text: "model result" }], details },
      { expanded: false, isPartial: false },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const text = collapsed?.render(160).join("\n") ?? "";
    expect(text).toContain("⚠ Started 1 of 2 subagents · 1 failed");
    expect(text).toContain(
      "✓ auth-review · reviewer · local/pi · openai-codex/gpt-5.6-sol:high · …very-secret-1",
    );
    expect(text).toContain("✗ docs-review · scout · no eligible route/model");
    expect(text.indexOf("auth-review")).toBeLessThan(text.indexOf("docs-review"));
    expect(text).toContain("→ /subagents for live status");
    expect(text).not.toContain("stale-tool");
    expect(text).not.toContain("stale progress");
    expect(text).not.toContain("tokens");

    const narrowLines = collapsed?.render(30) ?? [];
    const narrow = narrowLines.join("\n");
    expect(narrowLines.every((line) => visibleWidth(line) <= 30)).toBe(true);
    expect(narrow).toContain("auth-review");
    expect(narrow).toContain("reviewer");
    expect(narrow).toContain("local/pi");
    expect(narrow).toContain("openai-codex/gpt-5.6-sol");
    expect(narrow).toContain("…very-secret-1");

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const expanded = startTool?.renderResult?.(
      { content: [{ type: "text", text: "model result" }], details },
      { expanded: true, isPartial: false },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const expandedText = expanded?.render(100).join("\n") ?? "";
    expect(expandedText).toContain(
      "Selected candidate 2 after 1 earlier candidate was unavailable.",
    );
    expect(expandedText).toContain("Failure — docs-review [profile_no_eligible_model]");
    expect(expandedText).toContain("No eligible candidate remained.");
  });

  it("reconciles malformed persisted receipt slots without hiding failures", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startTool = captureSubagentTools(subagentServiceFixture({})).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const malformed = {
      version: 1,
      action: "start",
      cards: [],
      startEntries: [
        {
          index: 0,
          name: "valid-start",
          profile: "reviewer",
          status: "started",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "provider/model",
          effort: "high",
          runId: "agent-1",
        },
        { index: 1, name: "malformed-failure", status: "not-a-status" },
      ],
      startFailures: [
        { index: 1, name: "failed-start", code: "spawn_failed", message: "Spawn failed." },
      ],
    };
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const component = startTool?.renderResult?.(
      { content: [{ type: "text", text: "model result" }], details: malformed },
      { expanded: true, isPartial: false },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const text = component?.render(120).join("\n") ?? "";
    expect(text).toContain("⚠ Started 1 of 2 subagents · 1 failed");
    expect(text).toContain("✗ failed-start · generalist · no eligible route/model");
    expect(text).toContain("Failure — failed-start [spawn_failed]");

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const empty = startTool?.renderResult?.(
      {
        content: [{ type: "text", text: "model result" }],
        details: { version: 1, action: "start", cards: [] },
      },
      { expanded: false, isPartial: false },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    expect(empty?.render(80).join("\n")).toContain("⚠ Launch receipt unavailable");
    expect(empty?.render(80).join("\n")).not.toContain("Started 0");
  });

  it("keeps an attempted route/model on failed launch receipts and marks all-failed batches", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const startTool = captureSubagentTools(subagentServiceFixture({})).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: [],
      startEntries: [
        {
          index: 0,
          name: "worker-start",
          profile: "worker",
          status: "failed",
          routeStatus: "selected",
          host: "herdr",
          runtime: "claude",
          model: "claude-opus-4-1",
          effort: "high",
          candidateIndex: 2,
        },
      ],
      startFailures: [
        { index: 0, name: "worker-start", code: "spawn_failed", message: "Spawn failed." },
      ],
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const component = startTool?.renderResult?.(
      { content: [{ type: "text", text: "model result" }], details },
      { expanded: true, isPartial: false },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const text = component?.render(120).join("\n") ?? "";
    expect(text).toContain("✗ Failed to start 1 subagent");
    expect(text).toContain("✗ worker-start · worker · herdr/claude · claude-opus-4-1:high");
    expect(text).toContain("Attempted candidate 3 after 2 earlier candidates were unavailable.");
    expect(text).not.toContain("→ /subagents for live status");
  });

  it("projects timeout, cancellation, and first-finished await outcomes", () => {
    const running = view({ name: "still-working", state: "running" });
    const completed = view({
      id: "agent-2",
      name: "first-agent",
      state: "completed",
      endedAt: 10,
    });
    expect(awaitResultBanner({ action: "await", runs: [running], timedOut: true })).toEqual({
      color: "warning",
      text: "Await timed out · 1 unfinished",
    });
    expect(awaitResultBanner({ action: "await", runs: [running], cancelled: true })).toEqual({
      color: "warning",
      text: "Await canceled · 1 unfinished",
    });
    expect(
      awaitResultBanner({
        action: "await",
        runs: [view({ state: "waiting_for_parent" })],
        attentionRequired: true,
      }),
    ).toEqual({
      color: "warning",
      text: "Parent reply required for 1 subagent",
    });
    expect(
      awaitResultBanner({
        action: "await",
        runs: [running, completed],
        awaitUntil: "any_finished",
      }),
    ).toEqual({
      color: "accent",
      text: "first-agent finished first · 1 unfinished",
    });
    expect(
      awaitResultBanner({
        action: "await",
        runs: [
          view({
            name: "retained-agent",
            state: "reported",
            reportGeneration: 1,
            closeOnReport: false,
            endedAt: 5,
          }),
        ],
        awaitUntil: "any_finished",
      }),
    ).toEqual({ color: "accent", text: "retained-agent reported first · backend retained" });
  });

  it("keeps completed start and await cards compact until expanded", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as Theme;
    const run = view({
      id: "agent-secret-id",
      name: "review-agent",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      fastMode: true,
      state: "completed",
      finalText: "## Findings\nEverything passed.",
    });

    const compact = renderStartAwaitOverviewComponent([run], theme).render(120);
    expect(compact).toHaveLength(3);
    expect(compact[0]).toContain("✓ review-agent · …ent-secret-id");
    expect(compact[0]).toContain(
      "<toolOutput>local/pi · openai-codex/gpt-5.6-sol:high ⚡</toolOutput>",
    );
    expect(compact[0]).toContain("<success>finished</success>");
    expect(compact[1]).toContain("↳ review-agent: Findings");
    expect(compact[2]).toBe("<dim>▸ final report · expand to view</dim>");

    const expanded = renderExpandedStartAwaitResult([run], theme).render(120).join("\n");
    expect(expanded).toContain("<dim>▾ final report</dim>");
    expect(expanded).toContain("Report 1 of 1 — review-agent");
    expect(expanded).toContain("agent-secret-id");

    const markdown = renderExpandedStartAwaitResult([run], theme).render(80).join("\n");
    expect(markdown).toContain("Findings");
    expect(markdown).not.toContain("## Findings");
  });

  it("renders both a final report and failure when a run preserves both", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Theme;
    const rendered = renderExpandedStartAwaitResult(
      [view({ state: "failed", finalText: "Partial findings", error: "Transport failed" })],
      theme,
    )
      .render(100)
      .join("\n");
    expect(rendered).toContain("Report 1 of 2 — auth-review");
    expect(rendered).toContain("Partial findings");
    expect(rendered).toContain("Failure 2 of 2 — auth-review");
    expect(rendered).toContain("Transport failed");
  });

  it("marks omitted card content and report truncation explicitly", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Theme;
    const rendered = renderExpandedStartAwaitResult(
      [
        {
          ...view({ state: "completed", finalText: "Partial report" }),
          finalTextTruncated: true,
        },
      ],
      theme,
    )
      .render(100)
      .join("\n");
    expect(rendered).toContain("content truncated; use subagent_status");

    const compact = renderStartAwaitOverviewComponent(
      [view({ state: "completed", finalText: undefined })],
      theme,
    )
      .render(100)
      .join("\n");
    expect(compact).toContain("completed without a final report");
  });

  it("keeps final start rendering as an immutable receipt when card content was omitted", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const tool = captureSubagentTools(startCapturingService([])).get("subagent_start");
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: [
        {
          ...view({ state: "completed", finalText: undefined }),
          finalTextTruncated: true,
        },
      ],
      contentOmitted: true,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const component = tool?.renderResult?.(
      { content: [{ type: "text", text: "Recovered bounded report text." }], details },
      { isPartial: false, expanded: true },
      theme,
    ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    const rendered = component?.render(100).join("\n") ?? "";
    expect(rendered).toContain("✓ Started 1 subagent");
    expect(rendered).toContain("auth-review · generalist · local/pi");
    expect(rendered).toContain("→ /subagents for live status");
    expect(rendered).not.toContain("Recovered bounded report text.");
    expect(rendered).not.toContain("completed without a final report");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const collapsed = tool?.renderResult?.(
      { content: [{ type: "text", text: "Recovered bounded report text." }], details },
      { isPartial: false, expanded: false },
      theme,
    ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(collapsed?.render(120).join("\n")).not.toContain("report content was omitted");
  });

  it("aligns wide summary columns and truncates models first on narrow terminals", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Theme;
    const first = view({ name: "a", model: "short-model", state: "completed" });
    const second = view({
      id: "agent-2",
      name: "longer-agent-name",
      model: "a-very-long-provider/model-identifier-that-needs-truncation",
      state: "completed",
    });
    const wide = renderExpandedStartAwaitResult([first, second], theme).render(110);
    expect(wide[0]?.indexOf("short-model")).toBe(wide[1]?.indexOf("a-very-long"));

    const narrow = renderExpandedStartAwaitResult([second], theme).render(36);
    expect(narrow[0]).toContain("longer-agent-name");
    expect(narrow[1]).toContain(":high");
    expect(narrow[2]).toContain("finished");
    expect(narrow.join("\n")).not.toContain(second.model);
    expect(narrow.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it("sanitizes provenance and falls back to bounded text for malformed persisted details", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const malicious = view({
      selection: {
        source: "profile-candidate",
        reason: "selected\u001b[31m\nforged-row",
        skippedCandidates: [
          { candidate: "bad\nmodel", code: "bad\u001b[2J", reason: "reason\rforged" },
        ],
      },
    });
    const rendered = renderExpandedStartAwaitResult([malicious], theme).render(100).join("\n");
    expect(rendered).not.toContain("\nforged-row");

    const tool = captureSubagentTools(startCapturingService([])).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const component = tool?.renderResult?.(
      {
        content: [{ type: "text", text: `Safe fallback\u001b[31m${"x".repeat(100_000)}` }],
        details: { version: 1, action: "start", cards: [{ hostile: true }] },
      },
      { isPartial: false, expanded: true },
      theme,
    ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(() => component?.render(100_000)).not.toThrow();
    const fallback =
      component
        ?.render(100_000)
        .map((line) => line.trimEnd())
        .join("\n") ?? "";
    expect(fallback).toContain("Safe fallback");
    expect(fallback).toContain("tool output truncated; narrow the request");
    expect(fallback.length).toBeLessThanOrEqual(48_000);
    expect(fallback).not.toContain("\u001b");
  });

  it("labels failed-run expansion as failure details", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as Theme;
    const failed = view({ state: "failed", error: "child failed" });
    expect(renderStartAwaitOverviewComponent([failed], theme).render(120)).toContain(
      "<dim>▸ failure detail · expand to view</dim>",
    );
  });

  it("keeps partial batch-start failures compact", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as Theme;
    const failures = [{ index: 1, name: "broken-agent", message: "spawn failed" }];
    const compact = renderStartAwaitOverviewComponent(
      [view({ name: "good-agent" })],
      theme,
      failures,
    )
      .render(120)
      .join("\n");
    expect(compact).toContain("<success>⠋ good-agent · agent-1</success>");
    expect(compact).toContain("<error>✗ broken-agent</error> · <error>failed to start</error>");
    expect(compact).toContain("<dim>spawn failed</dim>");
    expect(compact).toContain("▸ failure details · expand to view");

    const expanded = renderExpandedStartAwaitResult([view({ name: "good-agent" })], theme, failures)
      .render(120)
      .join("\n");
    expect(expanded).toContain("spawn failed");
  });

  it("omits unknown usage from detailed status while still rendering known usage", () => {
    const unknown = formatRun(view({ usage: emptyUsage() }), true);
    expect(unknown).toContain("Subagent status");
    expect(unknown).not.toContain("Usage");
    const known = formatRun(
      view({
        usage: {
          input: 600,
          output: 400,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_000,
          cost: 0.5,
        },
      }),
      true,
    );
    expect(known).toContain("Usage      1.0k tokens · $0.50");
  });
});
