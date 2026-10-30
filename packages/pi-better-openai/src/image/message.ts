import { Container, Image } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  getTextContent,
  planCompactPresentation,
  type CodePreviewMessagePresenter,
} from "pi-code-previews";
import { imagePromptSubject, imageRecord, imageRecordSummary } from "./compact-summary.ts";
import {
  base64ByteLength,
  IMAGE_TITLE,
  renderImageBody,
  renderImageRequest,
} from "./presentation.ts";

const isImagePart = Schema.is(
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
);

/**
 * A delivered image message: the request as its heading, its facts, then the native image Pi
 * draws below the frame. Compact rows add the facts only expanded.
 */
export const presentImageMessage =
  (cwd: () => string): CodePreviewMessagePresenter =>
  (message, options, theme) => {
    const { expanded } = options;
    const compact = options.collapsedStyle === "compact";
    const record = imageRecord(message.details);
    const content = message.content;
    const image = Predicate.isString(content)
      ? undefined
      : Option.getOrUndefined(Arr.findFirst(content, isImagePart));
    const { collapsedSummary } = planCompactPresentation({
      summary: record && imageRecordSummary(record, { hasImage: image !== undefined, expanded }),
      phase: "settled",
      isError: false,
      expanded,
      heading: record && { subject: imagePromptSubject(record.prompt), action: record.action },
    });
    const prompt = record?.prompt ?? "";
    const body = () =>
      renderImageBody(
        {
          record,
          text: Predicate.isString(content) ? content : getTextContent(content),
          imageBytes: image && base64ByteLength(image.data),
          cwd: cwd(),
        },
        { expanded, isError: false, nested: compact },
        theme,
      );
    // A preview heading names the prompt alone, as the tool's preview heading does.
    const { action: _action, metadata: _metadata, ...previewSummary } = collapsedSummary;
    return {
      name: "openai_image",
      label: IMAGE_TITLE,
      summary: compact ? collapsedSummary : previewSummary,
      ...(!compact && { collapsed: body }),
      expanded: () => {
        const shown = new Container();
        if (prompt) shown.addChild(renderImageRequest({ prompt }, theme, IMAGE_REQUEST));
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

// The heading's subject is a shortened prompt, so expansion shows all of it.
const IMAGE_REQUEST = { prompt: false, action: true } as const;
