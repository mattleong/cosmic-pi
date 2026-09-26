import { expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeTuiHost, openPresentation, waitMounted } from "./support/host.ts";
import { emptyForm as request, formOwner as owner } from "./support/questionnaire.ts";
import { makeOwnedFormTuiHost } from "../src/boundary/host-form-tui.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import type { OwnedFormRequest } from "../src/protocol.ts";

const foreign = { render: () => ["foreign"], invalidate: () => {} };
const open = (h: ReturnType<typeof makeTuiHost>, input: OwnedFormRequest = request) =>
  openPresentation(h, (bridge) => makeOwnedFormTuiHost(h.ctx, bridge)(input, owner));

it.effect("docks private forms above the input and resizes without losing the mounted dialog", () =>
  Effect.gen(function* () {
    const h = makeTuiHost();
    const { bridge, controller, pending } = yield* open(h, {
      ...request,
      message: "prose\n".repeat(200),
    });
    const rejected = expect(pending).rejects.toBeDefined();
    h.mount!();
    const component = h.component!;
    const widget = [...h.widgets.values()][0]!;
    expect(component.render(200)).toEqual([]);
    expect(widget.render(200).length).toBeGreaterThan(0);
    expect(widget.render(200).length).toBeLessThan(h.tui.terminal.rows);
    component.handleInput?.("b");
    expect(widget.render(200)).toEqual([]);
    h.tui.terminal.columns = 160;
    h.tui.terminal.rows = 24;
    expect(bridge.resume()).toBe(true);
    expect(h.component).toBe(component);
    expect([...h.widgets.values()][0]).toBe(widget);
    expect(component.render(160)).toEqual([]);
    expect(widget.render(160).length).toBeGreaterThan(0);
    expect(widget.render(160).length).toBeLessThan(h.tui.terminal.rows);
    controller.abort();
    yield* Effect.promise(() => rejected);
    expect(h.stack).toEqual([]);
    expect(h.widgets.size).toBe(0);
    expect(widget.render(160)).toEqual([]);
  }),
);

it.effect("hides and resumes the same draft while cancellation preserves foreign overlays", () =>
  Effect.gen(function* () {
    const h = makeTuiHost();
    const { bridge, controller, pending } = yield* open(h);
    const rejected = expect(pending).rejects.toBeDefined();
    h.mount!();
    h.component!.handleInput?.("b");
    expect(bridge.resume()).toBe(true);
    h.component!.handleInput?.("b");
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => rejected);
    expect(h.stack).toEqual([foreign]);
    expect(bridge.resume()).toBe(false);
  }),
);

it.effect("a hidden form drops input until the host resumes it", () =>
  Effect.gen(function* () {
    const h = makeTuiHost();
    const { bridge, pending } = yield* open(h);
    h.mount!();
    h.component!.handleInput?.("b");
    h.component!.handleInput?.("\r");
    expect(h.done).not.toHaveBeenCalled();
    expect(bridge.resume()).toBe(true);
    h.component!.handleInput?.("\r");
    expect(yield* Effect.promise(() => pending)).toEqual({ action: "accept", content: {} });
  }),
);

it.effect(
  "waits for foreign prompt release before mounting and never waits for a broken custom Promise",
  () =>
    Effect.gen(function* () {
      const gate = makeAskUserPromptGate();
      gate.started();
      const h = makeTuiHost(gate);
      const controller = new AbortController();
      const pending = Effect.runPromise(
        makeOwnedFormTuiHost(h.ctx, makeAskUserDialogBridge(), gate)(request, owner),
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toBeDefined();
      yield* Effect.yieldNow;
      expect(h.customCalls).toBe(0);
      gate.ended();
      yield* waitMounted(h);
      h.mount!();
      h.done.mockImplementation(() => {
        throw new Error("private host diagnostic");
      });
      controller.abort();
      yield* Effect.promise(() => rejected);
      expect(h.stack).toEqual([]);
    }),
);
