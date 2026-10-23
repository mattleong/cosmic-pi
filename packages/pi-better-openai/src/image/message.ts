import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Image, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  getTextContent,
  planCompactPresentation,
  renderCompactIssues,
  renderCompactRow,
} from "pi-code-previews";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import { imagePromptSubject, imageRecord, imageRecordSummary } from "./compact-summary.ts";
import {
  base64ByteLength,
  headingShowsPrompt,
  renderImageBody,
  renderImageHeading,
  renderImageRequest,
} from "./presentation.ts";

const isImagePart = Schema.is(
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
);

export interface ImageMessage<Details> {
  readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: Details;
}

export interface ImageMessageOptions {
  readonly expanded: boolean;
  readonly compact: boolean;
  readonly cwd: string;
}

export function renderImageMessage<Details>(
  message: ImageMessage<Details>,
  options: ImageMessageOptions,
  theme: Theme,
): Component {
  const { expanded, compact } = options;
  const record = imageRecord(message.details);
  const content = message.content;
  const image = Predicate.isString(content) ? undefined : content.find(isImagePart);
  const { collapsedSummary } = planCompactPresentation({
    summary: record && imageRecordSummary(record, { hasImage: image !== undefined, expanded }),
    phase: "settled",
    isError: false,
    expanded,
    heading: record && { subject: imagePromptSubject(record.prompt), action: record.action },
  });
  const prompt = record?.prompt ?? "";
  const body = renderImageBody(
    {
      record,
      text: Predicate.isString(content) ? content : getTextContent(content),
      imageBytes: image && base64ByteLength(image.data),
      cwd: options.cwd,
    },
    { expanded, isError: false, nested: compact },
    theme,
  );
  const text = composeToolComponent((width) => {
    if (width <= 0) return [];
    const lines = compact
      ? [
          renderCompactRow(
            { name: "openai_image", phase: "settled", summary: collapsedSummary, expanded },
            theme,
            width,
          ),
          ...renderCompactIssues(collapsedSummary.issues, theme, width, expanded),
        ]
      : [
          renderImageHeading(prompt, theme, width),
          ...renderCompactIssues(collapsedSummary.issues, theme, width, expanded, ""),
        ];
    if (expanded && prompt)
      lines.push(
        ...renderImageRequest({ prompt }, theme, {
          prompt: !compact && headingShowsPrompt(prompt, width),
          action: true,
        }).render(width),
      );
    if (expanded || !compact) lines.push(...body.render(width));
    return lines;
  });
  const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(text);
  if (image)
    box.addChild(
      new Image(
        image.data,
        image.mimeType,
        { fallbackColor: (line) => theme.fg("dim", line) },
        record?.savedPath
          ? { maxWidthCells: 80, maxHeightCells: 24, filename: record.savedPath }
          : { maxWidthCells: 80, maxHeightCells: 24 },
      ),
    );
  return box;
}
