import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  type ToolPresentationHarness,
} from "../../testing";
import type { CompactAnimationScheduler } from "../../src/tools/compact-summary";
import { createNativeToolSearchRenderers } from "../../src/tools/native-tool-search-render";
import { createBuiltinPreviewRenderers } from "../../src/tools/renderers/registration";
import { textResult } from "../support/render";

interface VirtualTimer {
  due: number;
  readonly interval: number;
  readonly tick: () => void;
}

// Advances the wall clock and fires the session scheduler's fixed-interval timers in due order.
function virtualClock(start: number) {
  let now = start;
  const timers = new Set<VirtualTimer>();
  vi.setSystemTime(now);
  const schedule: CompactAnimationScheduler = (interval, tick) => {
    const timer: VirtualTimer = { due: now + interval, interval, tick };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  };
  return {
    schedule,
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    },
    advance(milliseconds: number) {
      const end = now + milliseconds;
      for (;;) {
        let next: VirtualTimer | undefined;
        for (const timer of timers)
          if (timer.due <= end && (!next || timer.due < next.due)) next = timer;
        if (!next) break;
        now = next.due;
        vi.setSystemTime(now);
        next.due += next.interval;
        next.tick();
      }
      now = end;
      vi.setSystemTime(now);
    },
  };
}

type Clock = ReturnType<typeof virtualClock>;

const rows = (harness: ToolPresentationHarness) => Arr.join(harness.render(120), "\n");

const elapsedLabel = (text: string) =>
  Fn.pipe(
    text,
    Str.match(/Elapsed \d+s/u),
    Option.map(([label]) => label),
    Option.getOrUndefined,
  );

// Records each render request the row makes, then redraws it as Pi would.
function recordRedraws(clock: Clock, harness: () => ToolPresentationHarness) {
  const started = clock.now;
  const redraws: Array<{ readonly at: number; readonly text: string }> = [];
  const invalidate = () => {
    harness().invalidate();
    redraws.push({ at: clock.now - started, text: rows(harness()) });
  };
  return { redraws, invalidate };
}

let restoreSettings: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  restoreSettings = applyPresentationSettings({
    toolCallTiming: true,
    toolCallCollapsedStyle: "preview",
    toolCallBackground: "off",
  });
});

afterEach(() => {
  restoreSettings();
  vi.useRealTimers();
});

test("a running row without animation redraws only when its whole-second elapsed label changes", () => {
  const clock = virtualClock(50_250);
  const renderers = createBuiltinPreviewRenderers("bash", {
    cwd: "/project",
    selfShell: false,
    scheduleAnimation: clock.schedule,
    enabledTools: ["bash"],
  });
  assert.ok(renderers);
  const bash = createToolPresentationHarness(renderers);
  const { redraws, invalidate } = recordRedraws(clock, () => bash);
  bash.call({ command: "make test" }, { executionStarted: true, invalidate });
  clock.advance(400);
  bash.result(textResult("compiling"), { isPartial: true });
  assert.equal(elapsedLabel(rows(bash)), undefined);
  clock.advance(3_100);
  assert.deepEqual(
    Arr.map(redraws, ({ at, text }) => ({ at, label: elapsedLabel(text) })),
    [
      { at: 1_000, label: "Elapsed 1s" },
      { at: 2_000, label: "Elapsed 2s" },
      { at: 3_000, label: "Elapsed 3s" },
    ],
  );
  bash.result(textResult("done"), { isPartial: false });
  assert.equal(clock.pending, 0);
  clock.advance(2_000);
  assert.equal(redraws.length, 3);
});

test("a running row that declares animateProgress still redraws every spinner frame", () => {
  const clock = virtualClock(50_250);
  const toolSearch = createToolPresentationHarness(
    createNativeToolSearchRenderers({ scheduleAnimation: clock.schedule }),
  );
  const { redraws, invalidate } = recordRedraws(clock, () => toolSearch);
  toolSearch.call({ query: "docs" }, { executionStarted: true, invalidate });
  toolSearch.result({ content: [], details: undefined }, { isPartial: true });
  const first = rows(toolSearch);
  clock.advance(3 * SPINNER_FRAME_MS + 10);
  assert.deepEqual(
    Arr.map(redraws, ({ at }) => at),
    [SPINNER_FRAME_MS, 2 * SPINNER_FRAME_MS, 3 * SPINNER_FRAME_MS],
  );
  const frames = [first, ...Arr.map(redraws, ({ text }) => text)];
  for (let index = 1; index < frames.length; index++)
    assert.notEqual(frames[index], frames[index - 1], "each tick must draw the next spinner frame");
  toolSearch.result({ content: [{ type: "text", text: "docs_lookup" }], details: undefined });
  assert.equal(clock.pending, 0);
});
