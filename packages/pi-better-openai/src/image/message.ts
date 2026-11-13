import { Container, Image } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  getTextContent,
  planCompactPresentation,
  type CodePreviewMessagePresenter,
  type CompactSummary,
} from "pi-code-previews";
import { findOrUndefined } from "pi-cosmic-core/array";
import {
  imageHeadingsShowPrompt,
  imagePromptSubject,
  imageRecord,
  imageRecordSummary,
} from "./compact-summary.ts";
import {
  base64ByteLength,
  imageMessageRevealsMore,
  renderImageBody,
  renderImageRequest,
  type ImageView,
} from "./presentation.ts";

// The message names its result, so the request's action would only repeat the tool row.
const withoutAction = ({ action: _action, ...summary }: CompactSummary): CompactSummary => summary;

const isImagePart = Schema.is(
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
);

/**
 * The image the user's `/openai image` command delivered: the request as its heading, its facts,
 * then the native image Pi draws below the frame. Compact rows add the facts only expanded. No tool
 * row describes this image, so the message carries every fact itself; its heading names the result
 * rather than the tool, so it reads apart from an unrelated `openai_image` row beside it.
 */
export const presentImageMessage =
  (cwd: () => string): CodePreviewMessagePresenter =>
  (message, options, theme) => {
    const { expanded } = options;
    const compact = options.collapsedStyle === "compact";
    const record = imageRecord(message.details);
    const content = message.content;
    const image = Predicate.isString(content) ? undefined : findOrUndefined(content, isImagePart);
    const summary = record && imageRecordSummary(record, { hasImage: image !== undefined });
    const { collapsedSummary } = planCompactPresentation({
      summary: summary && withoutAction(summary),
      phase: "settled",
      isError: false,
      expanded,
      heading: record && { subject: imagePromptSubject(record.prompt) },
    });
    const prompt = record?.prompt ?? "";
    const view: ImageView = {
      record,
      text: Predicate.isString(content) ? content : getTextContent(content),
      imageBytes: image && base64ByteLength(image.data),
      cwd: cwd(),
    };
    const body = () => renderImageBody(view, { expanded, isError: false, nested: compact }, theme);
    // A preview heading names the prompt alone, as the tool's preview heading does.
    const { action: _action, metadata: _metadata, ...previewSummary } = collapsedSummary;
    const ready = record?.status === "completed" && image !== undefined;
    return {
      name: ready ? "image_ready" : "image_result",
      label: ready ? "Image ready" : "Image result",
      summary: compact ? collapsedSummary : previewSummary,
      ...(imageMessageRevealsMore(view) && {
        expandLabel: prompt && !imageHeadingsShowPrompt(prompt) ? "prompt" : "details",
      }),
      ...(!compact && { collapsed: body }),
      expanded: (headingState) => {
        const shown = new Container();
        if (prompt)
          shown.addChild(
            renderImageRequest({ prompt }, theme, {
              ...IMAGE_REQUEST,
              cwd: view.cwd,
              headingState,
            }),
          );
        shown.addChild(body());
        return shown;
      },
      ...(image && {
        attachments: [
          new Image(
            image.data,
            image.mimeType,
            { fallbackColor: (line) => theme.fg("dim", line) },
            record?.savedPath
              ? { maxWidthCells: 80, maxHeightCells: 24, filename: record.savedPath }
              : { maxWidthCells: 80, maxHeightCells: 24 },
          ),
        ],
      }),
    };
  };

// Expanded, the message adds the complete prompt where its heading can't name it exactly, which
// its tag then names, and the revised prompt and where the file was saved.
// The Prompt section draws unless the heading showed the whole prompt exactly.
const IMAGE_REQUEST = { prompt: false, action: true } as const;
