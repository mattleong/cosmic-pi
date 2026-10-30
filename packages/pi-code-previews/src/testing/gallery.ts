import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  CustomMessageComponent,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalControls } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import type { CodePreviewRenderers } from "../tools/renderers/shared/types";
import { hostObject } from "../shared/untrusted-value";
import type { ToolCallBackgroundMode } from "../config/schema";
import {
  createToolPresentationHarness,
  hostToolRow,
  withPresentationSettings,
} from "./tool-presentation";

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
  return Arr.flatMap(views, ({ expanded, width }) => {
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

const MESSAGE_BACKGROUNDS: readonly ToolCallBackgroundMode[] = ["border", "on", "off"];

/** A custom message in every background mode, as its renderer draws it inside Pi's spacer. */
export function galleryMessageFrames(
  render: MessageRenderer,
  scenario: GalleryMessageScenario,
): string[] {
  return Arr.flatMap(MESSAGE_BACKGROUNDS, (background) =>
    withPresentationSettings({ toolCallBackground: background }, () =>
      Arr.flatMap(GALLERY_VIEWS, ({ expanded, width }) => {
        const component = render(scenario.message, { expanded, outputPad: 1 }, plainTheme);
        const content = scenario.message.content;
        const fallback = [
          `[${scenario.message.customType}] (Pi default rendering)`,
          ...(Arr.isArray(content)
            ? Arr.map(content, (part) => (part.type === "text" ? part.text : `[${part.type}]`))
            : [content]),
        ];
        return frame(
          `${scenario.title} · ${background}`,
          expanded,
          width,
          component?.render(width) ?? fallback,
        );
      }),
    ),
  );
}

/** A transcript entry: a settled tool row or a custom message, drawn by Pi's own components. */
export type GalleryTranscriptEntry =
  | {
      readonly name: string;
      readonly tool: ToolRenderers;
      readonly args: unknown;
      readonly result: AgentToolResult<unknown> & { readonly isError?: boolean };
    }
  | { readonly render: MessageRenderer; readonly message: GalleryMessageScenario["message"] };

/**
 * Settled tool rows and custom messages in sequence, as Pi's transcript draws them with its own
 * spacing and shells, so messages can be reviewed beside the tool rows they should resemble.
 * Pi's components use its global theme, so callers initialize it first.
 */
export function galleryTranscriptFrames(
  title: string,
  entries: ReadonlyArray<GalleryTranscriptEntry>,
): string[] {
  return Arr.flatMap(GALLERY_VIEWS, ({ expanded, width }) =>
    frame(
      title,
      expanded,
      width,
      Arr.flatMap(entries, (entry) => {
        if ("render" in entry) {
          const row = new CustomMessageComponent(entry.message, entry.render, undefined, 1);
          row.setExpanded(expanded);
          return row.render(width);
        }
        const { isError = false, ...result } = entry.result;
        const row = hostToolRow(entry.name, hostObject(entry.args) ?? {}, entry.tool, {
          result: { ...result, isError },
        });
        row.setExpanded(expanded);
        return row.render(width);
      }),
    ),
  );
}

const frame = (title: string, expanded: boolean, width: number, lines: readonly string[]) => [
  `── ${title} · ${expanded ? "expanded" : "collapsed"} · ${width} cols`,
  ...Arr.map(lines, (line) => Fn.pipe(stripTerminalControls(line), Str.replace(/\s+$/u, ""))),
  "",
];
