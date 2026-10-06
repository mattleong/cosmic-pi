// Promise assertions are test-runner boundaries.
import { tmpdir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  type ToolPresentationHarness,
} from "pi-code-previews/testing";
import { deferredPromise, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { sourcedExtensionHost } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";

const output: AgentToolResult<unknown> = {
  content: [{ type: "text", text: "COMPLETE_OUTPUT recovery /tmp/evidence.txt" }],
  details: undefined,
};
/** One coordinator tool and the inactive workflow runner, with their complete evidence. */
const SAMPLES = [
  {
    name: "subagent_start",
    args: { agents: [{ task: "COMPLETE_TASK_INPUT", profile: "scout" }] },
    evidence: ["COMPLETE_TASK_INPUT", "COMPLETE_OUTPUT recovery /tmp/evidence.txt"],
  },
  {
    name: "subagent_workflow",
    args: { action: "start", script: "return 'COMPLETE_SCRIPT_INPUT';" },
    evidence: ["COMPLETE_SCRIPT_INPUT", "COMPLETE_OUTPUT recovery /tmp/evidence.txt"],
  },
] as const;
type Sample = (typeof SAMPLES)[number];

const frames = (row: ToolPresentationHarness, sample: Sample) =>
  row.cycle(sample.args, output, { states: [true, false, true] });

const context = (signal?: AbortSignal) =>
  extensionContextFixture({
    cwd: process.cwd(),
    signal,
    isProjectTrusted: () => false,
    hasUI: false,
    mode: "rpc" as const,
  });

/** The root application over a sourced host; `loadSettings` runs inside each startup. */
const replayApplication = (loadSettings: () => Promise<void> = () => Promise.resolve()) => {
  const host = sourcedExtensionHost();
  registerSubagentApplication(host.pi, {
    getAgentDirectory: () => nodePath.join(tmpdir(), "pi-subagents-tool-replay-tests"),
    loadSettings,
  });
  const dispatch = (name: string, event: { readonly reason?: string }, ctx = context()) =>
    Promise.resolve(host.handlers.get(name)?.(event, ctx));
  return {
    host,
    /** Pi reconstructs history, retaining each row's renderers, before startup registers tools. */
    coldRow: (sample: Sample) => {
      expect(host.tools.has(sample.name)).toBe(false);
      return createToolPresentationHarness(host.resolve(sample.name)!);
    },
    registeredFrames: (sample: Sample) =>
      frames(createToolPresentationHarness(host.tools.get(sample.name)!), sample),
    dispatch,
    emit: (name: string, event: { readonly reason?: string }, ctx = context()) =>
      settle(() => dispatch(name, event, ctx)),
  };
};

const expectEvidence = (rendered: ReturnType<typeof frames>, sample: Sample) => {
  for (const { text } of rendered.filter((frame) => frame.expanded))
    for (const evidence of sample.evidence) expect(text).toContain(evidence);
};

const compactSettings = () =>
  applyPresentationSettings({
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "off",
    toolCallTiming: false,
  });

describe("subagent tool history replay", () => {
  effectTest(
    "history adopts only the first registration, without activating the runner, until shutdown",
    function* () {
      const restore = compactSettings();
      let treeStyle = false;
      const app = replayApplication(() => {
        if (treeStyle) applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
        return Promise.resolve();
      });
      try {
        const drawn = SAMPLES.map((sample) => {
          const row = app.coldRow(sample);
          return { sample, row, cold: frames(row, sample) };
        });
        // Resolved before startup but first drawn after a later registration or shutdown.
        const lazy = SAMPLES.map((sample) => ({ sample, row: app.coldRow(sample) }));
        const retired = SAMPLES.map((sample) => ({ sample, row: app.coldRow(sample) }));
        yield* app.emit("session_start", { reason: "startup" });
        expect(app.host.active()).toContain("subagent_start");
        expect(app.host.active()).not.toContain("subagent_workflow");
        const first = new Map(SAMPLES.map((sample) => [sample, app.registeredFrames(sample)]));
        for (const { sample, row, cold } of drawn) {
          const adopted = frames(row, sample);
          expect(adopted).toEqual(first.get(sample));
          expect(adopted).not.toEqual(cold);
          expectEvidence(cold, sample);
          expectEvidence(adopted, sample);
        }

        treeStyle = true;
        yield* app.emit("session_tree", {});
        expect(app.host.active()).not.toContain("subagent_workflow");
        for (const { sample, row } of [...drawn, ...lazy]) {
          expect(app.registeredFrames(sample)).not.toEqual(first.get(sample));
          expect(frames(row, sample)).toEqual(first.get(sample));
          // Later rows use the registered definition itself.
          expect(app.host.resolve(sample.name)?.renderCall).toBe(
            app.host.tools.get(sample.name)?.renderCall,
          );
        }

        yield* app.emit("session_shutdown", { reason: "reload" });
        for (const { sample, row } of drawn) expect(frames(row, sample)).toEqual(first.get(sample));
        for (const { sample, row } of retired) {
          const raw = frames(row, sample);
          expect(raw).toEqual(drawn.find((entry) => entry.sample === sample)?.cold);
          expectEvidence(raw, sample);
        }
      } finally {
        yield* app.emit("session_shutdown", { reason: "quit" });
        restore();
      }
    },
  );

  for (const [failure, label] of [
    ["registration", "a registration error"],
    ["aborted", "an aborted first startup"],
    ["shutdown", "shutdown during the first startup"],
    ["tree", "tree navigation superseding the first startup"],
  ] as const)
    effectTest(`${label} leaves history raw for good`, function* () {
      const restore = compactSettings();
      const preview = deferredPromise();
      const pending = failure === "shutdown" || failure === "tree";
      const loadSettings = vi.fn(() => (pending ? preview.promise : Promise.resolve()));
      const app = replayApplication(loadSettings);
      try {
        const drawn = SAMPLES.map((sample) => {
          const row = app.coldRow(sample);
          return { sample, row, cold: frames(row, sample) };
        });
        if (failure === "registration") {
          app.host.rejectTools(true);
          yield* app.emit("session_start", { reason: "startup" });
          app.host.rejectTools(false);
        } else if (failure === "aborted")
          yield* app.emit("session_start", { reason: "startup" }, context(AbortSignal.abort()));
        else {
          const starting = app.dispatch("session_start", { reason: "startup" });
          yield* step(() => vi.waitFor(() => expect(loadSettings).toHaveBeenCalled()));
          const superseding =
            failure === "tree"
              ? app.dispatch("session_tree", {})
              : app.dispatch("session_shutdown", { reason: "quit" });
          preview.resolve();
          yield* step(() => Promise.all([starting, superseding]));
        }
        // A later successful registration in this factory still cannot adopt.
        if (failure !== "tree")
          yield* app.emit(failure === "shutdown" ? "session_start" : "session_tree", {});
        for (const { sample, row, cold } of drawn) {
          expect(app.host.tools.has(sample.name)).toBe(true);
          const after = frames(row, sample);
          expect(after).toEqual(cold);
          expect(after).not.toEqual(app.registeredFrames(sample));
          expectEvidence(after, sample);
        }
      } finally {
        yield* app.emit("session_shutdown", { reason: "quit" });
        restore();
      }
    });
});
