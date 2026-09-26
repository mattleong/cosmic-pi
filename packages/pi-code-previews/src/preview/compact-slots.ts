import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { withLastComponent } from "./tool-timing";

export type CompactRenderBody = (context: ToolRenderContext<any, any>) => Component;
export type CompactSlot = "call" | "result";

/** Signals that composition must reconsider only the failed slot's ownership. */
export class CompactSlotDrawFailure extends Schema.TaggedError<CompactSlotDrawFailure>()(
  "CompactSlotDrawFailure",
  {},
) {}

type Entry = {
  component: Component | undefined;
  body: Component | undefined;
  failed: boolean;
};

/** Original and content-only slots never share lastComponent or failure evidence. */
export class CompactSlots {
  private readonly entries = new Map<string, Entry>();
  private inputs: readonly unknown[] = [];

  private entry(slot: CompactSlot, content: boolean): Entry {
    const key = `${slot}:${content}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { component: undefined, body: undefined, failed: false };
      this.entries.set(key, entry);
    }
    return entry;
  }

  update(context: ToolRenderContext<any, any>, result: AgentToolResult<unknown> | undefined): void {
    // Pi recreates callbacks, contexts and result envelopes on invalidation, but retains
    // these input references. Expansion and theme changes are not new execution evidence.
    const inputs = [
      context.args,
      result?.content,
      result?.details,
      context.executionStarted,
      context.argsComplete,
      context.isPartial,
      context.isError,
      context.showImages,
    ];
    const changed = inputs.some((value, index) => !Object.is(value, this.inputs[index]));
    this.inputs = inputs;
    if (!changed) return;
    for (const entry of this.entries.values()) {
      if (entry.failed) entry.body = undefined;
    }
  }

  construct(
    slot: CompactSlot,
    content: boolean,
    render: CompactRenderBody,
    context: ToolRenderContext<any, any>,
    fallback: () => Component,
    reuse: boolean,
  ): Component {
    const entry = this.entry(slot, content);
    if ((reuse || entry.failed) && entry.body) return entry.body;
    let component: Component;
    try {
      component = render(withLastComponent(context, entry.component));
      entry.component = component;
      entry.failed = false;
    } catch {
      entry.component = undefined;
      entry.failed = true;
      entry.body = fallback();
      return entry.body;
    }
    let safeFallback: Component | undefined;
    entry.body = {
      render: (width) => {
        if (entry.failed) return (safeFallback ??= fallback()).render(width);
        try {
          return component.render(width);
        } catch {
          entry.component = undefined;
          entry.failed = true;
          throw new CompactSlotDrawFailure();
        }
      },
      handleMouse: (event) => (entry.failed ? undefined : component.handleMouse?.(event)),
      invalidate: () => {
        if (!entry.failed) component.invalidate();
      },
    };
    return entry.body;
  }

  invalidate(): void {
    for (const entry of this.entries.values()) entry.component?.invalidate();
  }
}
