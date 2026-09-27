/**
 * Plain-text frames of registered tool calls for visual review. Galleries render typical
 * scenarios so wording and layout changes can be read and diffed; nothing here is asserted.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer, stripTerminalControls } from "pi-cosmic-core";
import type { AdaptableToolDefinition } from "../tools/renderer-adapter";
import { createToolPresentationHarness } from "./tool-presentation";

export interface GalleryScenario {
  readonly title: string;
  readonly args: unknown;
  readonly result: AgentToolResult<unknown>;
  readonly isError?: boolean;
}

export interface GalleryView {
  readonly expanded: boolean;
  readonly width: number;
}

/** Collapsed at a wide and a narrow width, then expanded. */
export const GALLERY_VIEWS: readonly GalleryView[] = [
  { expanded: false, width: 100 },
  { expanded: false, width: 60 },
  { expanded: true, width: 100 },
];

/** One scenario through a registered tool, each view in a fresh harness. */
export function galleryFrames(
  tool: AdaptableToolDefinition,
  scenario: GalleryScenario,
  views: readonly GalleryView[] = GALLERY_VIEWS,
): string[] {
  const isError = scenario.isError ?? false;
  return views.flatMap(({ expanded, width }) => {
    const harness = createToolPresentationHarness(tool, { width });
    harness.call(scenario.args, { expanded, isError, isPartial: false, executionStarted: true });
    harness.result(scenario.result, { expanded, isError });
    return [
      `── ${scenario.title} · ${expanded ? "expanded" : "collapsed"} · ${width} cols`,
      ...harness.render(width).map((line) => stripTerminalControls(line).replace(/\s+$/u, "")),
      "",
    ];
  });
}

/** The directory a gallery run collects sections in; undefined outside a gallery run. */
export const galleryDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined => environment["PRESENTATION_GALLERY"] || undefined;

/** Writes one package's section into the gallery run's directory. */
export const writeGallerySection = (directory: string, name: string, lines: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(directory, `${name}.txt`), `${lines.join("\n")}\n`);
  }).pipe(Effect.provide(nodeFilePlatformLayer));
