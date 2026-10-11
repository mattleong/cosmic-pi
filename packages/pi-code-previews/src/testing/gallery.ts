import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalControls } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import type { CodePreviewRenderers } from "../tools/renderers/shared/types";
import { createToolPresentationHarness } from "./tool-presentation";

type GalleryPhase = "pending" | "running" | "settled";

export interface GalleryScenario<TArgs = unknown, TDetails = unknown> {
  readonly title: string;
  readonly args: TArgs;
  readonly result?: AgentToolResult<TDetails> | undefined;
  readonly isError?: boolean;
  readonly phase?: GalleryPhase;
  readonly durationMs?: number;
}

interface GalleryView {
  readonly expanded: boolean;
  readonly width: number;
}

const GALLERY_VIEWS: readonly GalleryView[] = [
  { expanded: false, width: 100 },
  { expanded: false, width: 60 },
  { expanded: true, width: 100 },
];

interface TimingSeed {
  readonly codePreviewTimingStartedAt: number;
  readonly codePreviewTimingEndedAt: number;
}

export function galleryFrames<TArgs, TDetails>(
  tool: CodePreviewRenderers<TArgs, TDetails, TimingSeed | Record<PropertyKey, never>>,
  scenario: GalleryScenario<TArgs, TDetails>,
  views: readonly GalleryView[] = GALLERY_VIEWS,
): string[] {
  const isError = scenario.isError ?? false;
  const phase = scenario.phase ?? "settled";
  const live = { isPartial: phase !== "settled", executionStarted: phase !== "pending" };
  return views.flatMap(({ expanded, width }) => {
    const harness = createToolPresentationHarness<TArgs, TDetails, TimingSeed>(tool, {
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
