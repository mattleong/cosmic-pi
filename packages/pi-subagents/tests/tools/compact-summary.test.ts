import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../../pi-code-previews/src/config/state.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import { view } from "./fixtures/tool-harness.ts";

interface AnimationCallback {
  tick?: () => void;
}

function summarize<DetailsInput>(
  action: string,
  details: DetailsInput,
  phase: "running" | "settled" = "settled",
  args: {
    action?: string;
    runIds?: string[];
    profile?: string;
    agents?: { name: string; profile: string }[];
  } = {},
  isError = false,
) {
  const provider = createSubagentCompactSummary(`subagent_${action}`);
  return provider({
    phase,
    args,
    result: { content: [{ type: "text", text: "Untrusted success text" }], details },
    // SAFETY: The provider reads only isError from the renderer context.
    context: { isError } as Parameters<typeof provider>[0]["context"],
  });
}

describe("subagent compact semantic policy", () => {
  it("attributes recovery to each run and keeps unknown warning evidence conservative", () => {
    const summary = summarize(
      "list",
      makeCompactToolDetails({
        action: "list",
        runs: [view({ id: "one", state: "stopping" }), view({ id: "two", state: "stopping" })],
      }),
    );
    expect(summary?.issues?.coverage).toBe("complete");
    expect(
      summary?.issues?.entries.flatMap((entry) => entry.recovery).map((entry) => entry.code),
    ).toEqual(["one:cleanup-pending", "two:cleanup-pending"]);
    const unknown = summarize(
      "status",
      makeCompactToolDetails({
        action: "status",
        runs: [view({ id: "one", warning: "Review external ownership before retrying." })],
      }),
    );
    expect(unknown?.issues?.coverage).toBe("unknown");
    expect(JSON.stringify(unknown?.issues)).toContain("Review external ownership before retrying.");
  });
  it("uses start names or profiles before launch and combines observed state counts", () => {
    const provider = createSubagentCompactSummary("subagent_start");
    for (const agent of [{ name: "Review auth", profile: "reviewer" }, { profile: "reviewer" }]) {
      const summary = provider({
        args: { agents: [agent] },
        phase: "running",
        result: undefined,
        // SAFETY: The provider only reads isError from this render context.
        context: { isError: false } as Parameters<typeof provider>[0]["context"],
      });
      expect(summary?.subject).toBe("name" in agent ? agent.name : agent.profile);
      expect(summary?.counters?.join(" ")).not.toContain("finished");
    }
    const summary = summarize(
      "list",
      makeCompactToolDetails({
        action: "list",
        runs: [view({ id: "one", state: "running" }), view({ id: "two", state: "completed" })],
      }),
    );
    expect(summary?.counters).toHaveLength(1);
    expect(summary?.counters?.[0]).toContain("1 running");
    expect(summary?.counters?.[0]).toContain("1 completed");
    expect(summary?.metadata).toEqual([]);
  });
  it("keeps a requested target separate from lifecycle operations throughout rendering", () => {
    const provider = createSubagentCompactSummary("subagent_lifecycle");
    const args = { action: "interrupt", runIds: ["target-1"] };
    for (const phase of ["pending", "running", "settled"] as const) {
      const summary = provider({
        phase,
        args,
        result:
          phase === "pending"
            ? undefined
            : {
                content: [],
                details: makeCompactToolDetails({
                  action: "interrupt",
                  runs: [view({ id: "target-1", name: "Worker", state: "running" })],
                }),
              },
        // SAFETY: The provider only reads isError from this render context.
        context: { isError: false } as Parameters<typeof provider>[0]["context"],
      });
      expect(summary?.subject).toBe(phase === "pending" ? "target-1" : "Worker");
      expect(summary?.action).toBe("interrupt");
      expect(summary?.metadata).not.toContain("target-1");
      expect(summary?.expandedResultOwnsCall).toBeUndefined();
    }
  });

  it("retains a retry successor distinct from the requested source without duplicate identity", () => {
    for (const name of ["Retry worker", "source-1", "successor-2"]) {
      const summary = summarize(
        "lifecycle",
        makeCompactToolDetails({
          action: "retry",
          runs: [view({ id: "successor-2", name, state: "running" })],
        }),
        "settled",
        { action: "retry", runIds: ["source-1"] },
      );
      expect(summary?.action).toBe("retry");
      expect(summary?.subject).toBe("source-1");
      expect(summary?.metadata).not.toContain("successor-2");
      expect(summary?.metadata).not.toContain("source-1");
      expect(summary?.notices).toEqual([]);
    }
  });

  it("animates with the registering owner and releases the ticker on settlement", () => {
    const settings = { ...codePreviewSettings };
    setCodePreviewSettings({
      ...settings,
      toolCallCollapsedStyle: "compact",
      toolCallTiming: false,
    });
    try {
      const tools: ToolDefinition<any, any, any>[] = [];
      const animation: AnimationCallback = {};
      let stopped = 0;
      registerSubagentTools(
        extensionApiFixture({
          registerTool: (tool: ToolDefinition<any, any, any>) => tools.push(tool),
        }),
        {
          environment: { cwd: "/project", projectTrusted: false },
          run: () => Promise.reject(new Error("not executed")),
          scheduleAnimation: (_interval, tick) => {
            animation.tick = tick;
            return () => {
              stopped++;
            };
          },
        },
      );
      const tool = tools.find((tool) => tool.name === "subagent_status")!;
      // SAFETY: The render-only fixture implements the shell's styling callbacks.
      const theme = {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme;
      let invalidated = 0;
      const args = { runIds: ["agent-1"] };
      const context = {
        args,
        state: {},
        toolCallId: "status",
        cwd: "/project",
        lastComponent: undefined,
        expanded: false,
        executionStarted: true,
        argsComplete: true,
        isPartial: true,
        isError: false,
        showImages: false,
        invalidate: () => {
          invalidated++;
        },
      };
      tool.renderCall?.(args, theme, context).render(100);
      expect(animation.tick).toBeTypeOf("function");
      animation.tick?.();
      expect(invalidated).toBeGreaterThan(0);
      tool
        .renderResult?.(
          { content: [], details: makeCompactToolDetails({ action: "status", runs: [] }) },
          { expanded: false, isPartial: false },
          theme,
          { ...context, isPartial: false },
        )
        .render(100);
      expect(stopped).toBe(1);
    } finally {
      setCodePreviewSettings(settings);
    }
  });
  it("uses decoded run states rather than output text", () => {
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "running" })],
    });
    const summary = summarize("status", details);
    expect(summary?.outcome).toBe("success");
    expect(summary?.counters).toContain("running");
    expect(summary?.metadata?.join(" ")).not.toContain("Untrusted");
  });

  it("does not present an incomplete or different target as a single named run", () => {
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ id: "visible", name: "Visible", state: "running" })],
    });
    for (const sample of [
      { details, ids: ["visible", "missing"] },
      { details: { ...details, runCount: 2 }, ids: ["visible"] },
      { details, ids: ["missing"] },
    ]) {
      const summary = summarize("status", sample.details, "settled", { runIds: sample.ids });
      expect(summary?.counters?.join(" ")).toContain("1 running");
    }
  });

  it("summarizes stable writer claims without treating them as blocked admission", () => {
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "running", writeIntent: "writer", writeClaims: ["src/a.ts"] })],
    });
    expect(summarize("status", details)?.outcome).toBe("success");
    expect(summarize("status", details)?.metadata).toEqual([]);
  });

  it("declines missing, mismatched, omitted and old details", () => {
    for (const details of [
      undefined,
      {},
      { version: 1, action: "status" },
      makeCompactToolDetails({ action: "list", runs: [] }),
    ]) {
      expect(summarize("status", details)).toBeUndefined();
    }
  });

  it("keeps attention visible while moving evidence to expansion", () => {
    for (const overrides of [
      {
        state: "waiting_for_parent" as const,
        question: { message: "May I edit another file?", requestId: "q-1", createdAt: 1 },
      },
      { state: "paused" as const },
      { state: "failed" as const, error: "Cleanup uncertain" },
      { writeIntent: "writer" as const, writeClaims: ["src/a.ts"], writeAdmissionPaused: true },
      { warning: "Fallback changed runtime" },
    ]) {
      const details = makeCompactToolDetails({ action: "status", runs: [view(overrides)] });
      expect(summarize("status", details)?.detailsOnExpand).toBe(true);
      expect(summarize("status", details)?.notices?.length).toBeGreaterThan(0);
      expect(summarize("status", details, "running")?.detailsOnExpand).toBe(true);
    }
  });

  it("reports live launch progress without prematurely classifying success", () => {
    const details = {
      version: 2,
      action: "start",
      startEntries: [
        {
          index: 0,
          name: "worker",
          profile: "worker",
          status: "pending",
          routeStatus: "resolving",
        },
      ],
    };
    const args = { agents: [{ name: "worker", profile: "worker" }] };
    expect(summarize("start", details, "running", args)?.counters).toContain("0/1 started");
    expect(summarize("start", details, "running", args)?.outcome).toBeUndefined();
    expect(summarize("start", details, "settled", args)?.outcome).toBe("uncertain");
    const started = {
      ...details,
      startEntries: [
        {
          ...details.startEntries[0],
          status: "started",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "provider/model",
          effort: "low",
          openaiFastMode: false,
          runId: "started-1",
        },
      ],
    };
    for (const phase of ["running", "settled"] as const) {
      const summary = summarize("start", started, phase, args);
      expect(summary?.subject).toBe("worker");
      expect(summary?.counters).toContain("started");
      expect(summary?.outcome).toBe(phase === "running" ? undefined : "success");
    }
    expect(summarize("start", started)?.counters).toContain("1/1 started");
  });

  it("does not promote changing launch-entry details into live identity or metadata", () => {
    for (const changed of [false, true]) {
      const details = {
        version: 2,
        action: "start",
        startEntries: [
          {
            index: 0,
            name: changed ? "Renamed" : "Worker",
            profile: "worker",
            status: "started",
            routeStatus: "selected",
            host: "local",
            runtime: "pi",
            model: "provider/model",
            effort: "low",
            openaiFastMode: false,
            runId: "started-1",
            writerWorkspaceMode: changed ? "worktree" : "shared-checkout",
          },
          {
            index: 1,
            name: "Pending",
            profile: "worker",
            status: "pending",
            routeStatus: "resolving",
          },
        ],
      };
      const summary = summarize("start", details, "running");
      expect(summary?.subject).toBe("");
      expect(summary?.counters).toEqual(["1/2 started"]);
      expect(summary?.metadata).toEqual([]);
      expect(summary?.expandedResultOwnsCall).toBeUndefined();
    }
  });

  it("promotes the sole listed identity but not a partial multi-target status", () => {
    for (const action of ["list", "status"] as const) {
      const details = makeCompactToolDetails({
        action,
        runs: [view({ id: "only-1", name: "Worker" })],
      });
      expect(summarize(action, details)?.subject).toBe("Worker");
      expect(summarize(action, details)?.metadata).not.toContain("only-1");
      expect(summarize(action, details, "settled", { runIds: ["only-1", "other"] })?.subject).toBe(
        "",
      );
    }
  });

  it("requires target scope before summarizing awaits", () => {
    expect(
      summarize("await", { version: 2, action: "await", cards: [], awaitUntil: "all_finished" }),
    ).toBeUndefined();
    expect(
      summarize(
        "await",
        {
          version: 2,
          action: "await",
          cards: [],
          awaitUntil: "all_finished",
          attentionRequired: true,
        },
        "running",
      ),
    ).toBeUndefined();
  });

  it.each(["send", "reply"] as const)(
    "counts only accepted %s operations and retains failures",
    (action) => {
      for (const accepted of [0, 1, 2]) {
        const runs = Array.from({ length: accepted }, (_, index) =>
          view({ id: `accepted-${index}`, state: "running" }),
        );
        const details = makeCompactToolDetails({
          action,
          runs,
          actionFailures: [{ id: "missing", code: "run_not_found", message: "Run not found" }],
        });
        const summary = summarize(action, details);
        const receipt = summary?.counters?.join(" ");
        expect(receipt).toContain(action === "send" ? "sent" : "replied");
        expect(receipt?.match(/\d+/g) ?? []).toEqual(accepted === 1 ? [] : [String(accepted)]);
        expect(summary?.outcome).toBe("error");
        expect(summary?.notices?.some((notice) => notice.text.includes("missing"))).toBe(true);
        const live = summarize(action, details, "running");
        expect(live?.counters?.join(" ")).not.toMatch(/sent|replied/);
      }
      const success = summarize(action, makeCompactToolDetails({ action, runs: [view()] }));
      expect(success?.outcome).toBe("success");
      const bounded = summarize(action, {
        ...makeCompactToolDetails({ action, runs: [view()] }),
        runCount: 3,
      });
      expect(bounded?.counters?.join(" ")).toContain("3");
      expect(bounded?.counters?.join(" ")).toContain("1/3");
      expect(bounded?.notices?.some((notice) => notice.text.includes("Bounded"))).toBe(true);
    },
  );

  it("classifies action failures without claiming incomplete recovery details", () => {
    const details = makeCompactToolDetails({
      action: "send",
      runs: [],
      actionFailures: [{ id: "agent-1", code: "run_not_found", message: "Run not found" }],
    });
    const summary = summarize("send", details);
    expect(summary?.outcome).toBe("error");
    expect(summary?.failure).toBeUndefined();
    expect(summary?.notices?.map((notice) => notice.text).join(" ")).toContain("agent-1");
  });

  it.each([
    ["stopped", "cancelled"],
    ["stopping", "uncertain"],
    ["paused", "warning"],
    ["waiting_for_parent", "warning"],
  ] as const)("classifies %s without a clean success icon", (state, outcome) => {
    const details = makeCompactToolDetails({ action: "status", runs: [view({ state })] });
    expect(summarize("status", details)?.outcome).toBe(outcome);
    expect(summarize("status", details, "settled", {}, true)).toBeUndefined();
  });

  it.each([{}, { awaitedRunIds: ["context"] }])(
    "uses exact requested targets with absent or conflicting projected scope",
    (scope) => {
      const projected = makeCompactToolDetails({
        action: "status",
        runs: [
          view({ id: "target", state: "completed" }),
          view({ id: "context", state: "paused" }),
        ],
      });
      if (projected.action === "models") throw new Error("Expected cards");
      const summary = summarize(
        "await",
        {
          version: 2,
          action: "await",
          cards: projected.cards,
          awaitUntil: "all_finished",
          ...scope,
        },
        "settled",
        { runIds: ["target"] },
      );
      expect(summary?.counters).toContain("finished");
      expect(summary?.subject).toBe("auth-review");
      expect(summary?.expandedResultOwnsCall).toBeUndefined();
      expect(summary?.metadata).not.toContain("target");
      expect(summary?.metadata).not.toContain("1 paused");
    },
  );

  it("keeps quarantine ahead of route-exhaustion replacement advice", () => {
    const summary = summarize("start", {
      version: 2,
      action: "start",
      startEntries: [
        {
          index: 0,
          name: "worker",
          profile: "worker",
          status: "failed",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "provider/model",
          effort: "low",
          openaiFastMode: false,
        },
      ],
      startFailures: [
        {
          index: 0,
          message: "Start failed",
          admittedRun: {
            runId: "quarantined-run",
            cleanupDisposition: "quarantined",
            retryDisposition: "exhausted",
            hasRemainingCandidate: false,
            remainingCandidateCount: 0,
          },
        },
      ],
    });
    expect(summary?.outcome).toBe("error");
    const notices = summary?.notices?.map((notice) => notice.text).join(" ");
    expect(notices).toContain("quarantined-run");
    expect(notices).toContain("quarantined");
    expect(notices).toContain("Do not retry or launch a replacement");
    expect(notices).not.toContain("only now consider");
  });

  it("matches claims operations to the claims detail family", () => {
    const details = makeCompactToolDetails({
      action: "claims",
      runs: [view({ writeIntent: "writer", writeClaims: ["src/a.ts"] })],
    });
    const summary = summarize("claims", details, "settled", { action: "list" });
    expect(summary?.action).toBe("list");
    expect(summary?.counters).toContain("1 file claim");
    expect(summary?.metadata?.join(" ")).not.toContain("src/a.ts");
    expect(
      summarize("claims", makeCompactToolDetails({ action: "list", runs: [] }), "settled", {
        action: "list",
      }),
    ).toBeUndefined();
  });

  it("branches paused recovery on capabilities", () => {
    for (const resumable of [true, false]) {
      const details = makeCompactToolDetails({
        action: "interrupt",
        runs: [view({ state: "paused", capabilities: resumable ? ["resume"] : [] })],
      });
      const text = summarize("lifecycle", details, "settled", { action: "interrupt" })
        ?.notices?.map((notice) => notice.text)
        .join(" ");
      expect(text).toContain(resumable ? 'action: "resume"' : 'action: "stop"');
      expect(text).toContain(resumable ? "subagent_await" : "confirm cleanup");
      if (!resumable) expect(text).not.toContain('action: "resume"');
    }
  });

  it("does not grant from projected offender audits or change peer claims", () => {
    for (const offender of [true, false]) {
      const details = makeCompactToolDetails({
        action: "status",
        runs: [
          view({
            state: "paused",
            writeIntent: "writer",
            writeAdmissionPaused: true,
            ...(offender && { writeViolationOffender: true }),
            writeClaims: ["src/a.ts"],
            writeAudit: { observedFileWrites: [], violations: [], bashWriteHints: 0 },
          }),
        ],
      });
      const text =
        summarize("status", details)
          ?.notices?.map((notice) => notice.text)
          .join(" ") ?? "";
      expect(text).not.toContain("paths:");
      expect(text).not.toContain("src/a.ts");
      if (offender) {
        expect(text).toContain("full audit");
        expect(text.indexOf('action: "resume_admission"')).toBeLessThan(
          text.indexOf('action: "resume"'),
        );
        expect(text).toContain("outside the workspace");
        expect(text).toContain("confirm process and writer cleanup");
      } else {
        expect(text).toContain("Do not change this peer's claims");
        expect(text).not.toContain('action: "resume"');
      }
    }
  });

  it("summarizes only await targets and leaves report bodies on expansion", () => {
    const projected = makeCompactToolDetails({
      action: "status",
      runs: [
        view({ id: "target", state: "completed", finalText: "SECRET REPORT BODY" }),
        view({ id: "descendant", state: "paused", parentRunId: "target" }),
      ],
    });
    if (projected.action === "models") throw new Error("Expected cards");
    const details = {
      version: 2,
      action: "await",
      cards: projected.cards,
      awaitedRunIds: ["target"],
      awaitUntil: "all_finished",
    };
    const summary = summarize("await", details);
    expect(summary?.metadata).not.toContain("1 completed");
    expect(summary?.counters).toContain("finished");
    expect(summary?.metadata).not.toContain("1 paused");
    const text = summary?.notices?.map((notice) => notice.text).join(" ");
    expect(summary?.metadata).toEqual([]);
    expect(text).not.toContain("SECRET REPORT BODY");
    expect(text).not.toContain('action: "resume"');
    const cancelled = summarize("await", { ...details, cancelled: true });
    expect(cancelled?.outcome).toBe("cancelled");
    expect(cancelled?.notices?.some((notice) => notice.text.includes("NOT stopped"))).toBe(true);
    const proxyCancelled = summarize("await", {
      ...details,
      cancelled: true,
      cancellationCleanup: "unconfirmed",
    });
    expect(proxyCancelled?.outcome).toBe("cancelled");
    const proxyNotices = proxyCancelled?.notices?.map((notice) => notice.text).join(" ");
    expect(proxyNotices).toContain("Root completion-claim cleanup is unconfirmed");
    expect(proxyNotices).toContain("completion_claim_conflict");
    expect(proxyNotices).not.toContain("await the requested targets again");
  });

  it("does not turn a completed descendant into a missing target's completion", () => {
    const projected = makeCompactToolDetails({
      action: "status",
      runs: [view({ id: "descendant", state: "completed", parentRunId: "target" })],
    });
    if (projected.action === "models") throw new Error("Expected cards");
    const summary = summarize(
      "await",
      {
        version: 2,
        action: "await",
        cards: projected.cards,
        awaitUntil: "all_finished",
      },
      "settled",
      { runIds: ["target"] },
    );
    expect(summary?.subject).toBe("target");
    expect(summary?.counters).toContain("0/1 finished");
    expect(summary?.outcome).toBe("uncertain");
    expect(summary?.notices?.some((notice) => notice.text.includes("no projected state"))).toBe(
      true,
    );
  });

  it("marks omitted details as bounded rather than complete fleet counts", () => {
    const details = makeCompactToolDetails({ action: "list", runs: [view()] });
    const summary = summarize("list", { ...details, runCount: 20, contentOmitted: true });
    expect(summary?.counters?.join(" ")).toContain("1/20 shown");
    expect(summary?.outcome).toBe("uncertain");
    expect(summary?.notices?.some((notice) => notice.text.includes("subagent_status"))).toBe(true);
  });

  it("preserves workspace pagination, orphan recovery and exact test gates", () => {
    const summary = summarize(
      "workspace",
      {
        version: 1,
        action: "workspace",
        operation: "review",
        workspaceId: "w",
        revisionId: "r",
        offset: 0,
        totalChars: 100,
        nextOffset: 50,
      },
      "settled",
      { action: "review" },
    );
    expect(
      summary?.issues?.entries.flatMap((entry) => entry.recovery).map((entry) => entry.code),
    ).toEqual(["read-revision", "prepare-revision", "test-preparation", "integrate-preparation"]);
    const text = summary?.notices?.map((notice) => notice.text).join(" ") ?? "";
    for (const required of [
      "ALL pages",
      "revisionId=r",
      "offset=50",
      "prepare",
      "tests",
      "preparationId",
    ])
      expect(text).toContain(required);
    const list = summarize(
      "workspace",
      {
        version: 1,
        action: "workspace",
        operation: "list",
        workspaceCount: 10,
        listedCount: 8,
        nextOffset: 8,
      },
      "settled",
      { action: "list" },
    );
    expect(list?.counters).toContain("8/10 workspaces shown");
    expect(
      list?.notices?.some((notice) =>
        notice.text.includes("Do not auto-adopt or delete an orphan"),
      ),
    ).toBe(true);
    expect(
      summarize(
        "workspace",
        {
          version: 1,
          action: "workspace",
          operation: "prepare",
          workspaceId: "w",
          revisionId: "r",
          preparationId: "p",
          preparedCwd: "/combined",
        },
        "settled",
        { action: "prepare" },
      )?.notices?.[0]?.text,
    ).toContain("/combined");
    expect(
      summarize(
        "workspace",
        {
          version: 1,
          action: "workspace",
          operation: "revise",
          workspaceId: "w",
          successorRunId: "successor",
        },
        "settled",
        { action: "revise" },
      )?.notices?.[0]?.text,
    ).toContain("Await successor successor");
  });

  it("declines incomplete workspace receipts instead of inventing recovery IDs", () => {
    for (const details of [
      { operation: "review", workspaceId: "w", offset: 0, totalChars: 100 },
      { operation: "prepare", workspaceId: "w", preparedCwd: "/combined" },
      { operation: "integrate", workspaceId: "w", revisionId: "r" },
      { operation: "list", workspaceCount: 1, listedCount: 2 },
    ])
      expect(
        summarize("workspace", { version: 1, action: "workspace", ...details }, "settled", {
          action: details.operation,
        }),
      ).toBeUndefined();
  });

  it("distinguishes proven report omissions from errors and unknown omissions", () => {
    const reports = makeCompactToolDetails({
      action: "list",
      runs: [view({ finalText: "report" })],
    });
    expect(summarize("list", reports)?.metadata).toEqual([]);
    expect(summarize("list", reports)?.notices).toEqual([]);
    for (const overrides of [{ error: "failure" }, { error: "failure", finalText: "report" }]) {
      const details = makeCompactToolDetails({ action: "list", runs: [view(overrides)] });
      expect(summarize("list", details)?.notices?.some((notice) => notice.kind === "warning")).toBe(
        true,
      );
    }
    if (reports.action === "models") throw new Error("Expected run details");
    const { reportsOnlyOmitted, ...unknown } = reports;
    expect(reportsOnlyOmitted).toBe(true);
    expect(summarize("list", unknown)?.outcome).toBe("uncertain");
    expect(summarize("list", unknown)?.notices?.some((notice) => notice.kind === "warning")).toBe(
      true,
    );
  });

  it("deduplicates repeated warnings within each run without losing attribution", () => {
    const warning = "Inspect the changed route";
    const details = makeCompactToolDetails({
      action: "status",
      runs: ["agent-a", "agent-b"].map((id) =>
        view({ id, name: id, warning, selection: { ...view().selection, warning } }),
      ),
    });
    const notices = summarize("status", details)?.notices?.filter((notice) =>
      notice.text.includes(warning),
    );
    expect(notices).toHaveLength(2);
    for (const id of ["agent-a", "agent-b"])
      expect(notices?.filter((notice) => notice.text.includes(id))).toHaveLength(1);
  });

  it("quiets only child-authored await warnings without dropping safety evidence", () => {
    for (const phase of ["running", "settled"] as const) {
      for (const extra of [
        {},
        { systemWarning: "System recovery" },
        { warningSource: undefined },
        { selection: { ...view().selection, warning: "Route recovery" } },
        { error: "Execution failed" },
      ]) {
        const projected = makeCompactToolDetails({
          action: "status",
          runs: [view({ warning: "Child advisory", warningSource: "child", ...extra })],
        });
        if (projected.action === "models") throw new Error("Expected cards");
        const summary = summarize(
          "await",
          {
            version: 2,
            action: "await",
            cards: projected.cards,
            awaitedRunIds: [projected.cards[0]!.id],
            awaitUntil: "all_finished",
          },
          phase,
        );
        const text = summary?.notices?.map((notice) => notice.text).join(" ") ?? "";
        expect(text.includes("Child advisory")).toBe("warningSource" in extra);
        if ("systemWarning" in extra) expect(text).toContain(extra.systemWarning);
        if ("selection" in extra) expect(text).toContain("Route recovery");
        if ("error" in extra) expect(summary?.outcome).toBe("error");
        for (const action of ["status", "list"] as const) {
          const other = summarize(action, { ...projected, action }, phase);
          expect(other?.notices?.some((notice) => notice.text.includes("Child advisory"))).toBe(
            true,
          );
        }
      }
    }
  });

  it("keeps running await counters stable while exposing new safety notices", () => {
    const snapshot = (reverse: boolean, warning?: string) => {
      const projected = makeCompactToolDetails({
        action: "status",
        runs: [
          view({
            id: "a",
            state: reverse ? "paused" : "running",
            currentTool: reverse ? "edit" : "read",
            progress: String(reverse),
            writeClaims: reverse ? ["a", "b"] : ["a"],
            warning,
          }),
          view({ id: "b", state: "completed" }),
        ],
      });
      if (projected.action === "models") throw new Error("Expected cards");
      return {
        version: 2,
        action: "await",
        cards: reverse ? [...projected.cards].reverse() : projected.cards,
        awaitedRunIds: ["a", "b"],
        awaitUntil: "all_finished",
      };
    };
    const first = summarize("await", snapshot(false), "running");
    const next = summarize("await", snapshot(true, "new warning"), "running");
    expect(first?.counters).toEqual(["1/2 finished"]);
    expect(first?.metadata).toEqual([]);
    expect(first?.expandedResultOwnsCall).toBeUndefined();
    expect(next?.counters).toEqual(first?.counters);
    expect(next?.notices?.some((notice) => notice.text.includes("new warning"))).toBe(true);
    const completed = snapshot(false);
    const finalProgress = summarize(
      "await",
      { ...completed, cards: completed.cards.map((card) => ({ ...card, state: "completed" })) },
      "running",
    );
    expect(finalProgress?.subject).toBe(first?.subject);
    expect(finalProgress?.counters).toEqual(["2/2 finished"]);
    expect(summarize("await", { ...snapshot(false), timedOut: true })?.outcome).toBe("warning");
    expect(summarize("await", { ...snapshot(false), cancelled: true })?.outcome).toBe("cancelled");
    expect(
      summarize("status", makeCompactToolDetails({ action: "status", runs: [] }), "running", {
        runIds: ["a", "b", "c"],
      })?.counters,
    ).toEqual(["3 targets"]);
  });

  it("only cautions about report integration for isolated writers", () => {
    for (const overrides of [
      { writeIntent: "read-only" as const },
      { writeIntent: "writer" as const, writerWorkspaceMode: "shared-checkout" as const },
      { writeIntent: "writer" as const, writerWorkspaceMode: "worktree" as const },
    ]) {
      const details = makeCompactToolDetails({
        action: "status",
        runs: [view({ ...overrides, state: "reported", finalText: "report" })],
      });
      const summary = summarize("status", details);
      expect(summary?.metadata).toEqual([]);
      expect(
        summary?.notices?.some((notice) => notice.text.includes("workspace integration")),
      ).toBe(overrides.writerWorkspaceMode === "worktree");
    }
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "reported" })],
    });
    expect(summarize("status", details)?.metadata).not.toContain("1 report");
  });

  it("keeps successful integrate facts and empty lists quiet without weakening nonempty recovery", () => {
    const workspace = (
      operation: string,
      receipt: Partial<import("../../src/tools/details-schema.ts").WorkspaceToolDetails>,
    ) =>
      summarize(
        "workspace",
        {
          version: 1,
          action: "workspace",
          operation,
          ...receipt,
        },
        "settled",
        { action: operation },
      );
    const integrated = workspace("integrate", {
      workspaceId: "w",
      revisionId: "r",
      preparationId: "p",
    });
    expect(integrated?.notices).toEqual([]);
    expect(integrated?.counters).toEqual(["integrated"]);
    expect(integrated?.metadata).toEqual([]);
    expect(integrated?.detailsOnExpand).toBe(true);
    expect(workspace("list", { workspaceCount: 0, listedCount: 0 })?.notices).toEqual([]);
    expect(workspace("list", {})?.notices).toHaveLength(1);
    const paged = workspace("list", { workspaceCount: 2, listedCount: 1, nextOffset: 1 });
    expect(paged?.notices?.some((notice) => notice.text.includes("offset=1"))).toBe(true);
  });

  it("counts static mixed profile eligibility without warning for usable alternatives", () => {
    const candidate = {
      host: "local",
      runtime: "pi",
      model: "provider/model",
      effort: "default",
      context: "fresh",
      writeIntent: "read-only",
      openaiFastMode: false,
      closeOnReport: true,
      status: "eligible",
      reason: "Static eligibility",
    };
    const profile = {
      id: "scout",
      description: "Scout",
      source: "builtin",
      isDefault: false,
      defaultContext: "fresh",
      defaultWriteIntent: "read-only",
      candidates: [
        candidate,
        { ...candidate, status: "skipped", reason: "Unavailable alternative" },
      ],
    };
    const discovery = (profiles: object[], extra = {}) =>
      summarize("models", {
        version: 2,
        action: "models",
        profiles,
        fallbackProfile: "generalist",
        ...extra,
      });
    const clean = discovery([profile, { ...profile, id: "worker", candidates: [] }]);
    expect(clean?.outcome).toBe("success");
    expect(clean?.notices).toEqual([]);
    expect(clean?.counters).toEqual(["1 statically eligible, 1 disabled profiles"]);
    for (const unavailable of [
      { ...profile, candidates: [{ ...candidate, status: "skipped" }] },
      { ...profile, source: "global-invalid", candidates: [] },
      { ...profile, source: "project-invalid" },
    ]) {
      const summary = discovery([unavailable]);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.notices).toHaveLength(1);
      expect(summary?.counters?.join(" ")).toContain("1 unavailable profiles");
      expect(summary?.counters?.join(" ")).toContain("0 statically eligible");
      expect(summary?.counters).not.toContain("1 eligible profiles");
    }
    expect(discovery([{ ...profile, candidates: [] }])?.counters).toEqual([
      "0 statically eligible, 1 disabled profiles",
    ]);
    expect(
      summarize(
        "models",
        { version: 2, action: "models", profiles: [profile], fallbackProfile: "generalist" },
        "settled",
        { profile: "scout" },
      )?.subject,
    ).toBe("scout");
    expect(discovery([profile], { contentOmitted: true })?.outcome).toBe("uncertain");
    expect(discovery([{ ...profile, source: "unknown" }])).toBeUndefined();
  });

  it("quiets only clean terminal static skip history and preserves expanded evidence", () => {
    const skipped = {
      candidate: "alternative",
      code: "pi_model_unknown",
      reason: "Historical missing model",
    };
    const selection = { ...view().selection, skippedCandidates: [skipped] };
    for (const state of ["completed", "reported"] as const) {
      const details = makeCompactToolDetails({
        action: "status",
        runs: [view({ state, selection })],
      });
      const summary = summarize("status", details);
      expect(summary?.notices).toEqual([]);
      expect(summary?.metadata).toEqual([]);
      expect(JSON.stringify(details)).toContain(skipped.reason);
      expect(summary?.detailsOnExpand).toBe(true);
      expect(summarize("status", details, "running")?.metadata).toEqual([]);
      for (const patch of [
        { warning: "Herdr to local fallback" },
        { selection: { ...selection, warning: "Explicit selection warning" } },
        {
          selection: {
            ...selection,
            skippedCandidates: [{ ...skipped, code: "start_failed_before_prompt" }],
          },
        },
        { state: "failed" as const },
        { error: "Failure evidence" },
        { writeAdmissionPaused: true },
      ]) {
        const unsafe = makeCompactToolDetails({
          action: "status",
          runs: [view({ state, selection, ...patch })],
        });
        expect(
          summarize("status", unsafe)?.notices?.some((notice) =>
            notice.text.includes(skipped.reason),
          ),
        ).toBe(true);
      }
      expect(
        summarize("status", { ...details, contentOmitted: true })?.notices?.some((notice) =>
          notice.text.includes(skipped.reason),
        ),
      ).toBe(true);
    }
  });

  it("keeps claim operations and failed launch recovery compact", () => {
    expect(
      summarize("claims", makeCompactToolDetails({ action: "claims", runs: [] }))?.detailsOnExpand,
    ).toBe(true);
    expect(
      summarize("start", {
        version: 2,
        action: "start",
        startEntries: [
          {
            index: 0,
            name: "worker",
            profile: "worker",
            status: "failed",
            routeStatus: "unavailable",
          },
        ],
        startFailures: [{ index: 0, message: "Cleanup not confirmed" }],
      })?.outcome,
    ).toBe("error");
  });
});
