import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Image, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
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
import { isCodexImageDetails } from "./types.ts";

interface ImagePart {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** The parts of a Pi custom message this renderer reads. */
export interface ImageMessage<Details> {
  readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: Details;
}

export interface ImageMessageOptions {
  readonly expanded: boolean;
  /** Compact style draws the shared compact row; preview style draws a tool heading. */
  readonly compact: boolean;
  /** Saved paths display relative to this directory. */
  readonly cwd: string;
}

const isImagePart = <Value>(value: Value): value is Value & ImagePart =>
  Predicate.isObject(value) &&
  value.type === "image" &&
  Predicate.isString(value.data) &&
  Predicate.isString(value.mimeType);

/** Messages saved before image content parts carried their image in details. */
const legacyImage = <Details>(details: Details): ImagePart | undefined =>
  isCodexImageDetails(details) &&
  Predicate.hasProperty(details, "data") &&
  Predicate.isString(details.data)
    ? { type: "image", data: details.data, mimeType: details.mimeType }
    : undefined;

/**
 * `/openai-image` messages classify their details exactly as the tool does, and show the same
 * body beneath one heading. This renderer owns the message's Image component, including images
 * that older messages kept in details.
 */
export function renderImageMessage<Details>(
  message: ImageMessage<Details>,
  options: ImageMessageOptions,
  theme: Theme,
): Component {
  const { expanded, compact } = options;
  const record = imageRecord(message.details);
  const content = message.content;
  const image =
    (Predicate.isString(content) ? undefined : content.find(isImagePart)) ??
    legacyImage(message.details);
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
          // Preview style has no shell for a message, so it draws the issue lines the shell
          // draws for the tool. A message is never an error, so its body states a cancellation.
          ...renderCompactIssues(collapsedSummary.issues, theme, width, expanded, ""),
        ];
    if (expanded && prompt)
      lines.push(
        ...renderImageRequest({ prompt }, theme, {
          prompt: !compact && headingShowsPrompt(prompt, width),
          action: true,
        }).render(width),
      );
    // A compact row is the whole collapsed message.
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
