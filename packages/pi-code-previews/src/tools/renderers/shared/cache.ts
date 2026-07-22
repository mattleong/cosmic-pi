import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { DeferredPreview, shouldRenderDeferred } from "../../../preview/deferred";
import { isCodePreviewSessionActive } from "../../../application/session-projection";

export function cachedPreview(
  state: Record<string, unknown>,
  keyName: string,
  componentName: string,
  key: string,
  create: () => Component,
  exactSource?: string,
): Component {
  const cached = state[componentName] as (Component & { cancel?: () => void }) | undefined;
  const sourceName = `${keyName}ExactSource`;
  const sourceMatches = exactSource === undefined || state[sourceName] === exactSource;
  if (state[keyName] !== key || !sourceMatches || !cached || typeof cached.render !== "function") {
    cached?.cancel?.();
    state[keyName] = key;
    if (exactSource !== undefined) state[sourceName] = exactSource;
    state[componentName] = create();
  }
  return state[componentName] as Component;
}

export function cachedDeferredPreview(
  state: Record<string, unknown>,
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
