/**
 * Plain-text frames of registered tool calls for visual review. Galleries render typical
 * scenarios so wording and layout changes can be read and diffed; nothing here is asserted.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalControls } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import type { AdaptableToolRenderers } from "../tools/cooperative-tools";
import { createToolPresentationHarness } from "./tool-presentation";

/**
 * `pending` is a call awaiting execution (argument warnings show here); `running` is a started
 * call with an optional partial result; `settled` (the default) is a finished call.
 */
type GalleryPhase = "pending" | "running" | "settled";

export interface GalleryScenario {
  readonly title: string;
  readonly args: unknown;
  readonly result?: AgentToolResult<unknown> | undefined;
  readonly isError?: boolean;
  readonly phase?: GalleryPhase;
  /** Replay a measured duration in the presentation fixture, without starting a real clock. */
  readonly durationMs?: number;
}

interface GalleryView {
  readonly expanded: boolean;
  readonly width: number;
}

/** Collapsed at a wide and a narrow width, then expanded. */
const GALLERY_VIEWS: readonly GalleryView[] = [
  { expanded: false, width: 100 },
  { expanded: false, width: 60 },
  { expanded: true, width: 100 },
];

/** One scenario through a registered tool, each view in a fresh harness. */
export function galleryFrames(
  tool: Pick<AdaptableToolRenderers, "renderShell" | "renderCall" | "renderResult">,
  scenario: GalleryScenario,
  views: readonly GalleryView[] = GALLERY_VIEWS,
): string[] {
  const isError = scenario.isError ?? false;
  const phase = scenario.phase ?? "settled";
  const live = { isPartial: phase !== "settled", executionStarted: phase !== "pending" };
  return views.flatMap(({ expanded, width }) => {
    const harness = createToolPresentationHarness(tool, {
      width,
      ...(scenario.durationMs !== undefined && {
        state: {
          codePreviewTimingStartedAt: 1000,
          codePreviewTimingEndedAt: 1000 + scenario.durationMs,
        },
      }),
    });
    harness.call(scenario.args, { expanded, isError, ...live });
    if (scenario.result) harness.result(scenario.result, { expanded, isError, ...live });
    return frame(`${scenario.title}${phase === "settled" ? "" : ` · ${phase}`}`, expanded, width, [
      ...harness.render(width),
    ]);
  });
}

type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

export interface GalleryMessageScenario {
  readonly title: string;
  readonly message: Parameters<MessageRenderer>[0];
}

/** One custom message through its registered renderer; Pi's default card when it declines. */
export function galleryMessageFrames(
  render: MessageRenderer,
  scenario: GalleryMessageScenario,
): string[] {
  return GALLERY_VIEWS.flatMap(({ expanded, width }) => {
    const component = render(scenario.message, { expanded, outputPad: 0 }, plainTheme);
    const content = scenario.message.content;
    const fallback = [
      `[${scenario.message.customType}] (Pi default rendering)`,
      ...(Array.isArray(content)
        ? content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        : [content]),
    ];
    return frame(scenario.title, expanded, width, component?.render(width) ?? fallback);
  });
}

const frame = (title: string, expanded: boolean, width: number, lines: readonly string[]) => [
  `── ${title} · ${expanded ? "expanded" : "collapsed"} · ${width} cols`,
  ...lines.map((line) => stripTerminalControls(line).replace(/\s+$/u, "")),
  "",
];
