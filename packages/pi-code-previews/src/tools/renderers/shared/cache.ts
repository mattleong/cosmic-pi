import { isFunctionValue } from "pi-cosmic-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { DeferredPreview, shouldRenderDeferred } from "../../../preview/deferred";
import { isCodePreviewSessionActive } from "../../../application/projection";
import type { RendererState } from "./types";

export function cachedPreview(
  state: RendererState,
  keyName: string,
  componentName: string,
  key: string,
  create: () => Component,
  exactSource?: string,
): Component {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const cached = state[componentName] as (Component & { cancel?: () => void }) | undefined;
  const sourceName = `${keyName}ExactSource`;
  const sourceMatches = exactSource === undefined || state[sourceName] === exactSource;
  if (state[keyName] !== key || !sourceMatches || !cached || !isFunctionValue(cached.render)) {
    cached?.cancel?.();
    state[keyName] = key;
    if (exactSource !== undefined) state[sourceName] = exactSource;
    state[componentName] = create();
  }
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  return state[componentName] as Component;
}

export function cachedDeferredPreview(
  state: RendererState,
  keyName: string,
  componentName: string,
  key: string,
  source: string,
  loadingLabel: string,
  theme: Theme,
  render: () => Component,
  invalidate: () => void,
): Component {
  return cachedPreview(
    state,
    keyName,
    componentName,
    key,
    () =>
      shouldRenderDeferred(source) && isCodePreviewSessionActive()
        ? new DeferredPreview(loadingLabel, theme, render, invalidate)
        : render(),
    source,
  );
}
