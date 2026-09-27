import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { expandedSection, getTextContent, previewIssuesSlot } from "pi-code-previews";
import {
  formatBytes,
  formatDisplayPath,
  restatesText,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import { imageFailureIssue, imageRecord } from "./compact-summary.ts";
import { imageResultText } from "./result-text.ts";
import type { CodexImageDetails, ToolParams } from "./types.ts";

const TITLE = "OpenAI image";

/** What an image tool result or command message shows beneath its heading. */
export interface ImageView {
  /** Validated details; absent for errors and malformed records. */
  readonly record: CodexImageDetails | undefined;
  /** The attached text exactly as the agent received it. */
  readonly text: string;
  /** Decoded size of the attached image, when one is attached. */
  readonly imageBytes: number | undefined;
  /** Saved paths display relative to this directory. */
  readonly cwd: string;
}

export interface ImageBodyOptions {
  readonly expanded: boolean;
  readonly isError: boolean;
  /** Under a compact heading, the facts nest like every other expanded section. */
  readonly nested: boolean;
}

/** The parts of Pi's render context a result body reads. */
export interface ImageResultContext {
  readonly cwd: string;
  readonly isError: boolean;
}

/** Decoded size of base64 image data, measured without decoding it. */
export const base64ByteLength = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

export const imageViewOf = <Details>(result: AgentToolResult<Details>, cwd: string): ImageView => {
  const image = result.content.find((part) => part.type === "image");
  return {
    record: imageRecord(result.details),
    text: getTextContent(result.content),
    imageBytes: image?.type === "image" ? base64ByteLength(image.data) : undefined,
    cwd,
  };
};

// Longer prompts keep renderToolHeader's own "[truncated]" cap; narrower rows clip at the width.
const HEADING_PROMPT_LIMIT = 160;

const promptRoom = (width: number): number =>
  Math.max(1, Math.min(HEADING_PROMPT_LIMIT, width - visibleWidth(TITLE) - 1));

/** "OpenAI image <prompt>" on one row, the prompt clipped to fit. */
export const renderImageHeading = (prompt: string, theme: Theme, width: number): string =>
  clipToWidth(
    renderToolHeader(
      { title: TITLE, subtitle: clipToWidth(sanitizeTerminalLine(prompt), promptRoom(width)) },
      theme,
    ),
    width,
    "",
  );

/** Whether the heading shows the whole prompt exactly at this width. */
export const headingShowsPrompt = (prompt: string, width: number): boolean =>
  sanitizeTerminalLine(prompt) === prompt && visibleWidth(prompt) <= promptRoom(width);

const OPTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["action", "Action"],
  ["images", "Input image"],
  ["model", "Model"],
  ["imageModel", "Image model"],
  ["outputFormat", "Output format"],
  ["save", "Save"],
  ["saveDir", "Save directory"],
]);

/** Which arguments the heading above already shows exactly. */
export interface ImageRequestOptions {
  readonly prompt: boolean;
  readonly action: boolean;
}

const optionLines = (args: Partial<ToolParams>, shown: ImageRequestOptions): string[] =>
  Object.entries(args).flatMap(([key, value]) => {
    if (key === "prompt" || (key === "action" && shown.action) || value === undefined) return [];
    const label = OPTION_LABELS.get(key) ?? key;
    const entries: ReadonlyArray<string | undefined> = Array.isArray(value) ? value : [value];
    return entries.map(
      (entry) =>
        `${label}: ${stripTerminalControls(Predicate.isString(entry) ? entry : String(JSON.stringify(entry)))}`,
    );
  });

/**
 * The request in full, apart from what the heading already shows exactly: the prompt under its
 * own label, then every other argument. Nothing is clipped.
 */
export function renderImageRequest(
  args: Partial<ToolParams>,
  theme: Theme,
  shown: ImageRequestOptions,
): Component {
  const container = new Container();
  if (!shown.prompt && Predicate.isString(args.prompt))
    container.addChild(
      expandedSection(
        theme,
        "Prompt",
        new Text(theme.fg("toolOutput", stripTerminalControls(args.prompt)), 0, 0),
      ),
    );
  const options = optionLines(args, shown);
  if (options.length > 0)
    container.addChild(
      expandedSection(theme, undefined, new Text(theme.fg("muted", options.join("\n")), 0, 0)),
    );
  return container;
}

/** Preview heading; the shell's issue lines sit directly beneath it, then the full request. */
export function renderImageCall<
  Context extends { readonly expanded: boolean; readonly state: object },
>(args: Partial<ToolParams>, theme: Theme, context: Context): Component {
  const prompt = Predicate.isString(args.prompt) ? args.prompt : "";
  const issues = previewIssuesSlot(context);
  return composeToolComponent((width) => {
    if (width <= 0) return [];
    const lines = [renderImageHeading(prompt, theme, width), ...issues.render(width)];
    if (context.expanded)
      lines.push(
        ...renderImageRequest(args, theme, {
          prompt: headingShowsPrompt(prompt, width),
          action: false,
        }).render(width),
      );
    return lines;
  });
}

/** Raw text worth showing: anything but the text these same details would produce. */
const rawText = (view: ImageView): string =>
  view.text.trim() && (!view.record || view.text !== imageResultText(view.record)) ? view.text : "";

/**
 * Format and size, the saved file, and once expanded the revised prompt and any raw text the
 * details do not already say. Pi and the message renderer draw the image itself. In preview
 * style a cancellation the call did not report as an error is stated here; the shell states
 * the ones it did, and a compact row shows it in its status.
 */
export function renderImageBody(
  view: ImageView,
  options: ImageBodyOptions,
  theme: Theme,
): Component {
  const { record } = view;
  const container = new Container();
  const facts = options.nested ? new Container() : container;
  if (options.nested) container.addChild(expandedSection(theme, undefined, facts));
  if (record?.status === "cancelled" && !options.nested && !options.isError)
    container.addChild(new Text(toolStatusLine(theme, "stopped", "Cancelled"), 0, 0));
  if (record) {
    const models = options.expanded
      ? [record.imageModel, `via ${record.model}`].filter(Boolean).join(" ")
      : record.imageModel;
    const summary = [
      record.outputFormat.toUpperCase(),
      view.imageBytes === undefined ? undefined : formatBytes(view.imageBytes),
      models,
    ].filter((fact): fact is string => Boolean(fact));
    facts.addChild(new Text(theme.fg("muted", sanitizeTerminalLine(summary.join(" · "))), 0, 0));
    if (record.savedPath)
      facts.addChild(
        new Text(
          `${theme.fg("muted", "Saved to")} ${theme.fg("toolOutput", stripTerminalControls(formatDisplayPath(record.savedPath, view.cwd)))}`,
          0,
          0,
        ),
      );
  }
  const raw = rawText(view);
  const error = options.isError && !record;
  if (options.expanded) {
    if (record?.revisedPrompt)
      container.addChild(
        expandedSection(
          theme,
          "Revised prompt",
          new Text(theme.fg("toolOutput", stripTerminalControls(record.revisedPrompt)), 0, 0),
        ),
      );
    if (raw)
      container.addChild(
        expandedSection(
          theme,
          error ? "Error" : "Raw result",
          new Text(
            theme.fg(error ? "error" : "toolOutput", stripTerminalControls(raw).trimEnd()),
            0,
            0,
          ),
        ),
      );
    return container;
  }
  // An error the issue line already states in full has nothing more to show.
  const hidden =
    Boolean(record?.revisedPrompt) ||
    (raw !== "" && !(error && restatesText(raw, imageFailureIssue(raw).message)));
  if (hidden)
    container.addChild(new Text(renderExpansionAffordance("details", false, theme), 0, 0));
  return container;
}

/** Preview result body: the running line while it runs, then the image facts. */
export function renderImageResult<Details>(
  result: AgentToolResult<Details>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ImageResultContext,
): Component {
  if (options.isPartial) return new Text(toolRunningLine(theme), 0, 0);
  return renderImageBody(
    imageViewOf(result, context.cwd),
    { expanded: options.expanded, isError: context.isError, nested: false },
    theme,
  );
}

/** Compact expansion's unique result content; the compact row already shows progress. */
export function renderImageContent<Details>(
  result: AgentToolResult<Details>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ImageResultContext,
): Component {
  if (options.isPartial) return new Container();
  return renderImageBody(
    imageViewOf(result, context.cwd),
    { expanded: true, isError: context.isError, nested: true },
    theme,
  );
}
