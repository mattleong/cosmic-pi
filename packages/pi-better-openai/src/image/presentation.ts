import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import {
  compactPlainText,
  expandedSection,
  getTextContent,
  previewIssuesSlot,
} from "pi-code-previews";
import { formatBytes } from "pi-cosmic-core/display";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { restatesText } from "pi-cosmic-core/message-text";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
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

export const IMAGE_TITLE = "OpenAI image";

export interface ImageView {
  readonly record: CodexImageDetails | undefined;
  readonly text: string;
  readonly imageBytes: number | undefined;
  readonly cwd: string;
}

export interface ImageBodyOptions {
  readonly expanded: boolean;
  readonly isError: boolean;
  readonly nested: boolean;
}

export interface ImageResultContext {
  readonly cwd: string;
  readonly isError: boolean;
}

export const base64ByteLength = (data: string): number => {
  const padding = Fn.pipe(data, Str.endsWith("==")) ? 2 : Fn.pipe(data, Str.endsWith("=")) ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

export const imageViewOf = <Details>(result: AgentToolResult<Details>, cwd: string): ImageView => {
  const image = Option.getOrUndefined(
    Arr.findFirst(result.content, (part) => part.type === "image"),
  );
  return {
    record: imageRecord(result.details),
    text: getTextContent(result.content),
    imageBytes: image?.type === "image" ? base64ByteLength(image.data) : undefined,
    cwd,
  };
};

const HEADING_PROMPT_LIMIT = 160;

const promptRoom = (width: number): number =>
  Math.max(1, Math.min(HEADING_PROMPT_LIMIT, width - visibleWidth(IMAGE_TITLE) - 1));

export const renderImageHeading = (prompt: string, theme: Theme, width: number): string =>
  clipToWidth(
    renderToolHeader(
      {
        title: IMAGE_TITLE,
        subtitle: clipToWidth(sanitizeTerminalLine(prompt), promptRoom(width)),
      },
      theme,
    ),
    width,
    "",
  );

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

export interface ImageRequestOptions {
  readonly prompt: boolean;
  readonly action: boolean;
}

const optionLines = (args: Partial<ToolParams>, shown: ImageRequestOptions): string[] =>
  Arr.flatMap(Rec.toEntries<string, unknown>(args), ([key, value]) => {
    if (key === "prompt" || (key === "action" && shown.action) || value === undefined) return [];
    const label = OPTION_LABELS.get(key) ?? key;
    const entries: readonly unknown[] = Arr.isArray(value) ? value : [value];
    return Arr.map(entries, (entry) => {
      const encoded: string | undefined = Predicate.isString(entry) ? entry : JSON.stringify(entry);
      return `${label}: ${compactPlainText(encoded ?? "undefined")}`;
    });
  });

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
        new Text(theme.fg("toolOutput", compactPlainText(args.prompt)), 0, 0),
      ),
    );
  const options = optionLines(args, shown);
  if (options.length > 0)
    container.addChild(
      expandedSection(theme, undefined, new Text(theme.fg("muted", Arr.join(options, "\n")), 0, 0)),
    );
  return container;
}

export function renderImageCall(
  args: Partial<ToolParams>,
  theme: Theme,
  context: { readonly expanded: boolean; readonly state: object },
): Component {
  const prompt = Predicate.isString(args.prompt) ? args.prompt : "";
  const issues = previewIssuesSlot(context);
  const { expanded } = context;
  return composeToolComponent((width) => {
    if (width <= 0) return [];
    const lines = [renderImageHeading(prompt, theme, width), ...issues.render(width)];
    if (expanded)
      lines.push(
        ...renderImageRequest(args, theme, {
          prompt: headingShowsPrompt(prompt, width),
          action: false,
        }).render(width),
      );
    return lines;
  });
}

const rawText = (view: ImageView): string =>
  Str.trim(view.text) && (!view.record || view.text !== imageResultText(view.record))
    ? view.text
    : "";

const recordFacts = (
  record: CodexImageDetails,
  view: ImageView,
  expanded: boolean,
  theme: Theme,
): Component[] => {
  const models = expanded
    ? Arr.join(
        Arr.filter(
          [record.imageModel, `via ${record.model}`],
          (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
        ),
        " ",
      )
    : record.imageModel;
  const summary = Arr.filter(
    [
      Str.toUpperCase(record.outputFormat),
      view.imageBytes === undefined ? undefined : formatBytes(view.imageBytes),
      models,
    ],
    (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
  );
  const facts = [new Text(theme.fg("muted", sanitizeTerminalLine(Arr.join(summary, " · "))), 0, 0)];
  if (record.savedPath)
    facts.push(
      new Text(
        `${theme.fg("muted", "Saved to")} ${theme.fg("toolOutput", compactPlainText(formatDisplayPath(record.savedPath, view.cwd)))}`,
        0,
        0,
      ),
    );
  return facts;
};

const expandedDetails = (
  record: CodexImageDetails | undefined,
  raw: string,
  error: boolean,
  theme: Theme,
): Component[] => [
  ...(record?.revisedPrompt
    ? [
        expandedSection(
          theme,
          "Revised prompt",
          new Text(theme.fg("toolOutput", compactPlainText(record.revisedPrompt)), 0, 0),
        ),
      ]
    : []),
  ...(raw
    ? [
        expandedSection(
          theme,
          error ? "Error" : "Raw result",
          new Text(
            theme.fg(error ? "error" : "toolOutput", Str.trimEnd(compactPlainText(raw))),
            0,
            0,
          ),
        ),
      ]
    : []),
];

const hasHiddenDetails = (record: CodexImageDetails | undefined, raw: string, error: boolean) =>
  Boolean(record?.revisedPrompt) ||
  (raw !== "" && !(error && restatesText(raw, imageFailureIssue(raw).message)));

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
  if (record)
    for (const fact of recordFacts(record, view, options.expanded, theme)) facts.addChild(fact);
  const raw = rawText(view);
  const error = options.isError && !record;
  if (options.expanded)
    for (const detail of expandedDetails(record, raw, error, theme)) container.addChild(detail);
  else if (hasHiddenDetails(record, raw, error))
    container.addChild(new Text(renderExpansionAffordance("details", false, theme), 0, 0));
  return container;
}

const imageResultRenderer =
  (nested: boolean) =>
  <Details>(
    result: AgentToolResult<Details>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ImageResultContext,
  ): Component => {
    if (options.isPartial) return nested ? new Container() : new Text(toolRunningLine(theme), 0, 0);
    return renderImageBody(
      imageViewOf(result, context.cwd),
      { expanded: nested || options.expanded, isError: context.isError, nested },
      theme,
    );
  };

export const renderImageResult = imageResultRenderer(false);

export const renderImageContent = imageResultRenderer(true);
