/** Source-only, test-runner-independent Activity fakes and gallery frames for producer tests. */
import { stripTerminalControls } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { ActivityComponent, makeActivityPresentation } from "./component.ts";
import type { ActivityRow } from "./model.ts";
import {
  ACTIVITY_DISCOVER,
  ACTIVITY_EVENT,
  ACTIVITY_HOST,
  activityKey,
  type ActivityEnvelope,
  type ActivityEvents,
  type ActivityItem,
} from "./protocol.ts";
import { renderActivityWidget } from "./widget.ts";

/**
 * An in-memory event bus whose host answers discovery for `sessionId`, records the latest
 * envelope, and acknowledges each registration.
 */
export function fakeActivityHost(sessionId = "session") {
  const hostToken = {};
  const listeners = new Map<string, Set<Parameters<ActivityEvents["on"]>[1]>>();
  let envelope: ActivityEnvelope | undefined;
  let capability: ActivityEnvelope | undefined;
  const events: ActivityEvents = {
    on: (name, handler) => {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(handler);
      listeners.set(name, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
    emit: (name, value) => {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
  events.on(ACTIVITY_DISCOVER, () =>
    events.emit(ACTIVITY_HOST, { version: 1, sessionId, hostToken, available: true }),
  );
  events.on(ACTIVITY_EVENT, (value) => {
    // SAFETY: The fake captures only envelopes emitted by the producer's protocol adapter.
    envelope = value as ActivityEnvelope;
    if (envelope.operation === "register") {
      capability = envelope;
      envelope.acknowledge?.(true);
    }
  });
  return { events, hostToken, get: () => envelope, capability: () => capability };
}

interface ActivityGalleryOptions {
  readonly title: string;
  readonly providerId: string;
  readonly items: readonly ActivityItem[];
  /** The producer's detail for an item, as its `getDetail` would return it. */
  readonly detail?: (itemId: string) => string | undefined;
  /** Items whose detail a manager frame opens, one frame each. */
  readonly open?: readonly string[];
  /** Widget widths, each rendered at every row bound. */
  readonly widths?: readonly number[];
  readonly maxRows?: readonly number[];
  readonly now?: number;
}

/**
 * Plain-text frames of producer items through the real Activity renderers, for galleries: the
 * persistent widget at each width and row bound, then the manager with each `open` item selected
 * and its detail loaded. Frames assert nothing.
 */
export function activityGalleryFrames(options: ActivityGalleryOptions): string[] {
  const { providerId } = options;
  // Producer items as the host holds them, in their first generation.
  const rows: readonly ActivityRow[] = Object.freeze(
    options.items.map((item) => ({
      ...item,
      key: activityKey(providerId, item.id),
      providerId,
      generation: 1,
    })),
  );
  const now = options.now ?? 0;
  const lines: string[] = [];
  const plain = (frame: readonly string[]) => frame.map((line) => stripTerminalControls(line));
  for (const maxRows of options.maxRows ?? [8])
    for (const width of options.widths ?? [60, 80, 100])
      lines.push(
        `── activity widget · ${options.title} · ${width} cols · ${maxRows} rows`,
        ...plain(renderActivityWidget(rows, width, maxRows, { now, theme: plainTheme })),
        "",
      );
  const width = 140;
  for (const itemId of options.open ?? []) {
    const presentation = makeActivityPresentation();
    // Finished branches start collapsed as history; open them so any item can be selected.
    for (const row of rows) presentation.expandedHistory.add(row.key);
    const component = new ActivityComponent({
      snapshot: () => rows,
      presentation,
      theme: plainTheme,
      height: () => 32,
      now: () => now,
      close: () => undefined,
      requestRender: () => undefined,
      loadDetail: (request, deliver) => {
        const id = rows.find((row) => row.key === request.key)?.id;
        const text = id === undefined ? undefined : options.detail?.(id);
        if (text !== undefined) deliver(text);
      },
    });
    const key = activityKey(providerId, itemId);
    component.render(width);
    for (let step = 0; step <= rows.length * 4 && component.shell.state.selectedId !== key; step++)
      component.handleInput("j");
    const found = component.shell.state.selectedId === key;
    if (found) component.handleInput("\r");
    lines.push(
      `── activity manager · ${options.title} · ${itemId}${found ? "" : " (not reachable)"}`,
      ...plain(component.render(width)),
      "",
    );
  }
  return lines;
}
