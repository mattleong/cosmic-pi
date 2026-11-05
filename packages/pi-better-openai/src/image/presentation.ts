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
  expandedBody,
  expandedDetails,
  expandedFields,
  expandedText,
  getTextContent,
  middleElide,
  previewIssuesSlot,
  type ExpandedField,
} from "pi-code-previews";
import { formatBytes } from "pi-cosmic-core/display";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { restatesText } from "pi-cosmic-core/message-text";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth, wrapFacts } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
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

const optionFields = (args: Partial<ToolParams>, shown: ImageRequestOptions): ExpandedField[] =>
  Arr.flatMap(Rec.toEntries<string, unknown>(args), ([key, value]) => {
    if (key === "prompt" || (key === "action" && shown.action) || value === undefined) return [];
    const entries: readonly unknown[] = Arr.isArray(value) ? value : [value];
    return [
      {
        label: OPTION_LABELS.get(key) ?? key,
        lines: Arr.map(entries, (entry) => {
          const encoded: string | undefined = Predicate.isString(entry)
            ? entry
            : JSON.stringify(entry);
          return compactPlainText(encoded ?? "undefined");
        }),
      },
    ];
  });

export function renderImageRequest(
  args: Partial<ToolParams>,
  theme: Theme,
  shown: ImageRequestOptions,
): Component {
  return expandedBody(
    !shown.prompt && Predicate.isString(args.prompt)
      ? expandedText(theme, "Prompt", [compactPlainText(args.prompt)])
      : undefined,
    expandedFields(theme, optionFields(args, shown)),
  );
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

const imageModels = (record: CodexImageDetails, expanded: boolean): string =>
  expanded
    ? Arr.join(
        Arr.filter(
          [record.imageModel, `via ${record.model}`],
          (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
        ),
        " ",
      )
    : (record.imageModel ?? "");

const imageFormat = (record: CodexImageDetails, view: ImageView): string =>
  Arr.join(
    Arr.filter(
      [
        Str.toUpperCase(record.outputFormat),
        view.imageBytes === undefined ? undefined : formatBytes(view.imageBytes),
      ],
      (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
    ),
    " · ",
  );

const savedPath = (record: CodexImageDetails, view: ImageView): string =>
  record.savedPath ? compactPlainText(formatDisplayPath(record.savedPath, view.cwd)) : "";

const SAVED_TO = "Saved to";

/**
 * Collapsed, the saved file stays on one line: its path when that fits, otherwise its file name,
 * shortened in the middle if even that is too wide. Expanded Details shows the whole path.
 */
const fittedSavedPath = (saved: string, room: number): string => {
  if (visibleWidth(saved) <= room) return saved;
  const name = Option.getOrElse(Arr.last(Str.split(saved, "/")), () => saved);
  return middleElide(name || saved, room);
};

/** A collapsed preview's facts: one muted summary line and where the image was saved. */
const collapsedFacts = (record: CodexImageDetails, view: ImageView, theme: Theme): Component[] => {
  const summary = Arr.filter(
    [imageFormat(record, view), imageModels(record, false)],
    Str.isNonEmpty,
  );
  const saved = sanitizeTerminalLine(savedPath(record, view));
  return [
    // Facts wrap between whole facts, so no row ends with a separator.
    composeToolComponent((width) =>
      Number.isFinite(width) && width >= 1
        ? Arr.map(wrapFacts(sanitizeTerminalLine(Arr.join(summary, " · ")), width), (line) =>
            theme.fg("muted", line),
          )
        : [],
    ),
    ...(saved
      ? [
          composeToolComponent((width) => [
            clipToWidth(
              `${theme.fg("muted", SAVED_TO)} ${theme.fg(
                "toolOutput",
                fittedSavedPath(saved, Math.max(1, width - visibleWidth(SAVED_TO) - 1)),
              )}`,
              width,
            ),
          ]),
        ]
      : []),
  ];
};

/** Expanded, the image's facts share one label column beneath the heading. */
const factField = (label: string, value: string): ExpandedField[] =>
  Str.isNonEmpty(value) ? [{ label, lines: [sanitizeTerminalLine(value)] }] : [];

const expandedFacts = (record: CodexImageDetails, view: ImageView, theme: Theme): Component =>
  expandedFields(theme, factField("Image", imageFormat(record, view)));

/** The model route and the saved file are technical facts, so they close the body in Details. */
const technicalDetails = (record: CodexImageDetails, view: ImageView, theme: Theme): Component => {
  const saved = savedPath(record, view);
  return expandedDetails(theme, [
    sanitizeTerminalLine(imageModels(record, true)),
    saved ? `${SAVED_TO} ${sanitizeTerminalLine(saved)}` : "",
  ]);
};

// An error that only restates its issue adds nothing; the issue above already shows it.
const restatesIssue = (raw: string, error: boolean): boolean =>
  error && restatesText(raw, imageFailureIssue(raw).message);

const expandedExtras = (
  record: CodexImageDetails | undefined,
  raw: string,
  error: boolean,
  theme: Theme,
): Component =>
  expandedBody(
    record?.revisedPrompt
      ? expandedText(theme, "Revised prompt", [compactPlainText(record.revisedPrompt)])
      : undefined,
    raw && !restatesIssue(raw, error)
      ? expandedText(
          theme,
          error ? "Error" : "Raw result",
          Str.split(Str.trimEnd(compactPlainText(raw)), "\n"),
          error ? "error" : "toolOutput",
        )
      : undefined,
  );

/**
 * Whether expanding a delivered image's message reveals more than its collapsed frame: the prompt
 * and the image's facts whenever there is a record, or the result's own text.
 */
export const imageMessageRevealsMore = (view: ImageView): boolean =>
  view.record !== undefined || rawText(view) !== "";

export function renderImageBody(
  view: ImageView,
  options: ImageBodyOptions,
  theme: Theme,
): Component {
  const { record } = view;
  const raw = rawText(view);
  const error = options.isError && !record;
  const cancelled =
    record?.status === "cancelled" && !options.nested && !options.isError
      ? new Text(toolStatusLine(theme, "stopped", "Cancelled"), 0, 0)
      : undefined;
  if (options.expanded || options.nested)
    return expandedBody(
      cancelled,
      record && expandedFacts(record, view, theme),
      options.expanded ? expandedExtras(record, raw, error, theme) : undefined,
      record && technicalDetails(record, view, theme),
    );
  const container = new Container();
  if (cancelled) container.addChild(cancelled);
  // The shell draws the expansion affordance the row or message declares.
  if (record) for (const fact of collapsedFacts(record, view, theme)) container.addChild(fact);
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
