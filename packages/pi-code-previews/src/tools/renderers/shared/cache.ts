import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { hasCodePreviewSessionCapability } from "../../../application/capability";
import { DeferredPreview, shouldRenderDeferred } from "../../../preview/deferred";
import type { RendererState } from "./types";

interface PreviewEntry {
  readonly dependencies: readonly unknown[];
  readonly component: Component;
}

const previewEntries = new WeakMap<object, Map<string, PreviewEntry>>();

function entriesFor(state: RendererState): Map<string, PreviewEntry> {
  const existing = previewEntries.get(state);
  if (existing) return existing;
  const created = new Map<string, PreviewEntry>();
  previewEntries.set(state, created);
  return created;
}

export function cachedPreview(
  state: RendererState,
  slot: string,
  dependencies: readonly unknown[],
  create: () => Component,
): Component {
  const entries = entriesFor(state);
  const cached = entries.get(slot);
  if (
    cached?.dependencies.length === dependencies.length &&
    dependencies.every((value, index) => Object.is(value, cached.dependencies[index]))
  )
    return cached.component;
  if (cached?.component instanceof DeferredPreview) cached.component.cancel();
  entries.delete(slot);
  const component = create();
  entries.set(slot, { dependencies, component });
  return component;
}

export function cachedDeferredPreview(
  state: RendererState,
  slot: string,
  dependencies: readonly unknown[],
  sourceCharacters: number,
  loadingLabel: string,
  theme: Theme,
  render: () => Component,
  invalidate: () => void,
): Component {
  return cachedPreview(state, slot, dependencies, () =>
    shouldRenderDeferred(sourceCharacters) && hasCodePreviewSessionCapability()
      ? new DeferredPreview(loadingLabel, theme, render, invalidate)
      : render(),
  );
}
