import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { hasCodePreviewSessionCapability } from "../../../application/capability";
import { DeferredPreview, shouldRenderDeferred } from "../../../preview/deferred";
import type { RendererState } from "./types";

interface PreviewEntry {
  readonly dependencies: readonly unknown[];
  readonly component: Component;
}

export function cachedPreview(
  state: RendererState,
  slot: string,
  dependencies: readonly unknown[],
  create: () => Component,
): Component {
  // SAFETY: This slot is owned and populated only by this cache.
  const cached = state[slot] as PreviewEntry | undefined;
  if (
    cached?.dependencies.length === dependencies.length &&
    dependencies.every((value, index) => Object.is(value, cached.dependencies[index]))
  )
    return cached.component;
  if (cached?.component instanceof DeferredPreview) cached.component.cancel();
  delete state[slot];
  const component = create();
  state[slot] = { dependencies, component } satisfies PreviewEntry;
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
