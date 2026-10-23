import { tmpdir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  type ToolPresentationHarness,
} from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  recordingExtensionHost,
  type DefaultedEventName,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { awaitDetails } from "../src/tools/details.ts";
import { awaitResultText } from "../src/tools/execute-await.ts";
import { view } from "./tools/fixtures/tool-harness.ts";
import { sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const output: AgentToolResult<unknown> = {
  content: [{ type: "text", text: "COMPLETE_OUTPUT recovery /tmp/evidence.txt" }],
  details: undefined,
};
const ARCHIVE_PATH = "/agent/subagents/reports/session-1/agent-1-1-replay.md";
const cutRun = view({
  id: "agent-1",
  state: "completed",
  reportGeneration: 1,
  finalText: "Report start.",
  finalTextTruncation: { retainedChars: 13, originalChars: 90_000, originalLines: 900 },
  reportArchive: { path: ARCHIVE_PATH, chars: 90_000, lines: 900, complete: true },
});
// Raw history shows the result text, which names the saved file; adopted rows also read it, and
// the retained report, from the persisted card.
const cutReport: AgentToolResult<unknown> = {
  content: [
    {
      type: "text",
      text: awaitResultText(
        "",
        [{ run: cutRun, completionReceipt: { id: "agent-1", generation: 1, claimToken: "c" } }],
        [],
      ),
    },
  ],
  details: awaitDetails({
    runs: [cutRun],
    awaitedRunIds: ["agent-1"],
    awaitUntil: "all_finished",
  }),
};
const archiveMentions = (text: string) =>
  Str.split(Fn.pipe(text, Str.replace(/\s+/gu, "")), ARCHIVE_PATH).length - 1;
const SAMPLES = [
  {
    name: "agent_start",
    args: { agents: [{ task: "COMPLETE_TASK_INPUT", profile: "scout" }] },
    result: output,
    evidence: ["COMPLETE_TASK_INPUT", "COMPLETE_OUTPUT recovery /tmp/evidence.txt"],
  },
  {
    name: "agent_await",
    args: { runIds: ["agent-1"], until: "all_finished" },
    result: cutReport,
    evidence: [ARCHIVE_PATH],
  },
] as const;
type Sample = (typeof SAMPLES)[number];

const frames = (row: ToolPresentationHarness, sample: Sample) =>
  row.cycle(sample.args, sample.result, { states: [true, false, true] });

const context = (signal?: AbortSignal) =>
  sessionContextFixture({ signal, isProjectTrusted: () => false });

const replayApplication = (loadSettings: () => Promise<void> = () => Promise.resolve()) =>
  Effect.gen(function* () {
    const host = recordingExtensionHost();
    registerSubagentApplication(host.pi, {
      getAgentDirectory: () => nodePath.join(tmpdir(), "pi-subagents-tool-replay-tests"),
      loadSettings,
    });
    const dispatch = <Name extends DefaultedEventName>(
      name: Name,
      event?: ExtensionEventNamed<Name>,
      ctx = context(),
    ) => host.emit(name, ctx, event);
    const emit = <Name extends DefaultedEventName>(
      name: Name,
      event?: ExtensionEventNamed<Name>,
      ctx = context(),
    ) => settle(() => dispatch(name, event, ctx));
    yield* Effect.addFinalizer(() =>
      emit("session_shutdown", { type: "session_shutdown", reason: "quit" }),
    );
    return {
      host,
      coldRow: (sample: Sample) => {
        expect(host.tools.has(sample.name)).toBe(false);
        return createToolPresentationHarness(host.resolve(sample.name)!);
      },
      registeredFrames: (sample: Sample) =>
        frames(createToolPresentationHarness(host.tools.get(sample.name)!), sample),
      dispatch,
      emit,
    };
  });

const expectEvidence = (rendered: ReturnType<typeof frames>, sample: Sample) => {
  for (const { text } of Arr.filter(rendered, (frame) => frame.expanded))
    for (const evidence of sample.evidence)
      expect(Fn.pipe(text, Str.replace(/\s+/gu, ""))).toContain(
        Fn.pipe(evidence, Str.replace(/\s+/gu, "")),
      );
};

const compactSettings = Effect.acquireRelease(
  Effect.sync(() =>
    applyPresentationSettings({
      toolCallCollapsedStyle: "compact",
      toolCallBackground: "off",
      toolCallTiming: false,
    }),
  ),
  (restore) => Effect.sync(restore),
);

describe("subagent tool history replay", () => {
  effectTest(
    "history adopts only the first registration, without activating the runner, until shutdown",
    function* () {
      yield* compactSettings;
      let treeStyle = false;
      const app = yield* replayApplication(() => {
        if (treeStyle) applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
        return Promise.resolve();
      });
      const drawn = Arr.map(SAMPLES, (sample) => {
        const row = app.coldRow(sample);
        return { sample, row, cold: frames(row, sample) };
      });
      const lazy = Arr.map(SAMPLES, (sample) => ({ sample, row: app.coldRow(sample) }));
      const retired = Arr.map(SAMPLES, (sample) => ({ sample, row: app.coldRow(sample) }));
      yield* app.emit("session_start", { type: "session_start", reason: "startup" });
      expect(app.host.active()).toContain("agent_start");
      const first = new Map(Arr.map(SAMPLES, (sample) => [sample, app.registeredFrames(sample)]));
      for (const { sample, row, cold } of drawn) {
        const adopted = frames(row, sample);
        expect(adopted).toEqual(first.get(sample));
        expect(adopted).not.toEqual(cold);
        expectEvidence(cold, sample);
        expectEvidence(adopted, sample);
        if (sample.name === "agent_await")
          for (const { expanded, text } of adopted)
            if (expanded) {
              expect(archiveMentions(text)).toBeGreaterThan(1);
              expect(text).toContain("Report start.");
            }
      }

      treeStyle = true;
      yield* app.emit("session_tree");
      for (const { sample, row } of [...drawn, ...lazy]) {
        expect(app.registeredFrames(sample)).not.toEqual(first.get(sample));
        expect(frames(row, sample)).toEqual(first.get(sample));
        expect(app.host.resolve(sample.name)?.renderCall).toBe(
          app.host.tools.get(sample.name)?.renderCall,
        );
      }

      yield* app.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
      for (const { sample, row } of drawn) expect(frames(row, sample)).toEqual(first.get(sample));
      for (const { sample, row } of retired) {
        const raw = frames(row, sample);
        expect(raw).toEqual(
          Option.getOrUndefined(Arr.findFirst(drawn, (entry) => entry.sample === sample))?.cold,
        );
        expectEvidence(raw, sample);
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
      yield* compactSettings;
      const preview = deferredPromise();
      const pending = failure === "shutdown" || failure === "tree";
      const loadSettings = vi.fn(() => (pending ? preview.promise : Promise.resolve()));
      const app = yield* replayApplication(loadSettings);
      const drawn = Arr.map(SAMPLES, (sample) => {
        const row = app.coldRow(sample);
        return { sample, row, cold: frames(row, sample) };
      });
      if (failure === "registration") {
        app.host.rejectTools(true);
        yield* app.emit("session_start", { type: "session_start", reason: "startup" });
        app.host.rejectTools(false);
      } else if (failure === "aborted")
        yield* app.emit(
          "session_start",
          { type: "session_start", reason: "startup" },
          context(AbortSignal.abort()),
        );
      else {
        const starting = app.dispatch("session_start", {
          type: "session_start",
          reason: "startup",
        });
        yield* step(() => vi.waitFor(() => expect(loadSettings).toHaveBeenCalled()));
        const superseding =
          failure === "tree"
            ? app.dispatch("session_tree")
            : app.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });
        preview.resolve();
        yield* step(() => Promise.all([starting, superseding]));
      }
      if (failure !== "tree")
        yield* app.emit(failure === "shutdown" ? "session_start" : "session_tree");
      for (const { sample, row, cold } of drawn) {
        expect(app.host.tools.has(sample.name)).toBe(true);
        const after = frames(row, sample);
        expect(after).toEqual(cold);
        expect(after).not.toEqual(app.registeredFrames(sample));
        expectEvidence(after, sample);
      }
    });
});
