import { Buffer } from "node:buffer";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import {
  MCP_RESULT_LIMITS,
  type McpAttachment,
  type McpNormalizedResult,
  type McpPrepareInput,
  type McpResultOrigin,
  type McpStoredImage,
} from "./model.ts";

export const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** Counts UTF-8, not UTF-16 code units, and never splits a surrogate pair. */
export const prefixBytes = (value: string, maxBytes: number): string => {
  let used = 0;
  let end = 0;
  for (const character of value) {
    const bytes = utf8Bytes(character);
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += character.length;
  }
  return value.slice(0, end);
};

export const boundedNotices = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.map((value) => prefixBytes(value, 512)))].slice(0, 16);

const jsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);
const jsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !jsonArray(value);
const jsonPrimitive = (value: Schema.Json): value is null | string | number | boolean =>
  !Predicate.isObjectOrArray(value);
const record = (value: Schema.Json): Schema.JsonObject | undefined =>
  jsonObject(value) ? value : undefined;

const dimensionsAllowed = (width: number, height: number): boolean =>
  width > 0 && height > 0 && width * height <= MCP_RESULT_LIMITS.imagePixels;

/** Header and container checks only. No native decoder, filesystem, or URI access. */
const supportedImage = (bytes: Buffer, mime: string): boolean => {
  if (mime === "image/png") {
    return (
      bytes.length >= 45 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString("ascii", 12, 16) === "IHDR" &&
      bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND" &&
      dimensionsAllowed(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    );
  }
  if (mime === "image/gif") {
    return (
      bytes.length >= 14 &&
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
      bytes[bytes.length - 1] === 0x3b &&
      dimensionsAllowed(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    );
  }
  if (mime === "image/webp") {
    if (
      bytes.length < 20 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      return false;
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X" && bytes.length >= 30) {
      return dimensionsAllowed(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    }
    if (
      format === "VP8 " &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 1 &&
      bytes[25] === 0x2a
    ) {
      return dimensionsAllowed(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      return dimensionsAllowed(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff));
    }
    return false;
  }
  if (mime === "image/jpeg") {
    if (
      bytes.length < 12 ||
      bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
    )
      return false;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return false;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return false;
      if (
        marker !== undefined &&
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return (
          length >= 8 &&
          dimensionsAllowed(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
        );
      }
      if (marker === 0xda || marker === 0xd9) return false;
      offset += length + 2;
    }
  }
  return false;
};

/** The SDK has decoded JSON already; this walker bounds our copy before serialization. */
export const normalizeResult = (input: McpPrepareInput): McpNormalizedResult => {
  const resultObject = record(input.reply.result);
  let origin: McpResultOrigin = {
    action: prefixBytes(input.action, 64),
    outcome: "completed",
    isError: resultObject?.isError === true,
  };
  if (input.outputValidation !== undefined)
    origin = { ...origin, outputValidation: input.outputValidation };
  Object.freeze(origin);
  const notices: string[] = [];
  const attachments: McpAttachment[] = [];
  const images: McpStoredImage[] = [];
  let nodes = 0;
  let acceptedBytes = 0;
  const charge = (bytes: number): void => {
    acceptedBytes += bytes;
    if (acceptedBytes > MCP_RESULT_LIMITS.acceptedBytes) throw new RangeError("result limit");
  };
  const notice = (message: string): void => {
    if (notices.length < 16 && !notices.includes(message)) notices.push(message);
  };
  if (input.outputValidation === "failed")
    notice(
      "Completed output failed validation. Do not repeat the operation to recover its output.",
    );

  const attachment = (
    block: { readonly [key: string]: Schema.Json },
    kind: McpAttachment["kind"],
    payload?: string,
  ): Schema.Json => {
    if (attachments.length >= MCP_RESULT_LIMITS.attachments)
      throw new RangeError("attachment limit");
    const index = attachments.length;
    const mimeType = Predicate.isString(block.mimeType)
      ? prefixBytes(block.mimeType, 128)
      : undefined;
    let uri = Predicate.isString(block.uri) ? prefixBytes(block.uri, 1_024) : undefined;
    if (uri !== undefined && /^data:/i.test(uri)) {
      uri = undefined;
      notice("Inline data URI omitted from the attachment descriptor.");
    }
    let supported = false;
    let bytes: number | undefined;
    if (payload !== undefined) {
      if (
        payload.length <= MCP_RESULT_LIMITS.acceptedBytes &&
        payload.length % 4 === 0 &&
        !/[^A-Za-z0-9+/]/.test(payload.replace(/={1,2}$/, ""))
      ) {
        bytes =
          (payload.length / 4) * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
        if ((kind === "image" || kind === "resource") && mimeType !== undefined) {
          supported = supportedImage(Buffer.from(payload, "base64"), mimeType);
          if (supported) images.push(Object.freeze({ index, mimeType, data: payload }));
        }
      }
      if (!supported)
        notice(
          "Unsupported or invalid binary attachment omitted; only checked PNG, JPEG, GIF, and WebP images can be read.",
        );
    } else if (kind === "link")
      notice("Resource links are untrusted references and were not followed.");
    else notice("Unsupported content was replaced with an attachment descriptor.");
    let descriptor: McpAttachment = { index, kind, supported };
    if (mimeType !== undefined) descriptor = { ...descriptor, mimeType };
    if (uri !== undefined) descriptor = { ...descriptor, uri };
    if (bytes !== undefined) descriptor = { ...descriptor, bytes };
    attachments.push(Object.freeze(descriptor));
    return { type: "attachment", ...descriptor };
  };

  // Copy and charge every input byte, including content that normalization discards.
  const copy = (value: Schema.Json, depth: number): Schema.Json => {
    if (++nodes > MCP_RESULT_LIMITS.nodes || depth > MCP_RESULT_LIMITS.depth)
      throw new RangeError("structure limit");
    if (jsonPrimitive(value)) {
      if (Predicate.isString(value) && utf8Bytes(value) > MCP_RESULT_LIMITS.acceptedBytes)
        throw new RangeError("string limit");
      charge(utf8Bytes(JSON.stringify(value)));
      return value;
    }
    if (jsonArray(value)) {
      charge(2 + value.length);
      return value.map((item) => copy(item, depth + 1));
    }
    const entries = Object.entries(value);
    charge(2 + entries.length * 2);
    return Object.fromEntries(
      entries.map(([key, item]) => {
        charge(utf8Bytes(JSON.stringify(key)));
        return [key, copy(item, depth + 1)];
      }),
    );
  };
  type ContentContext = "result" | "block" | "resource" | "message" | undefined;
  const normalize = (value: Schema.Json, context?: ContentContext): Schema.Json => {
    if (jsonArray(value)) return value.map((item) => normalize(item, context));
    const block = record(value);
    if (block === undefined) return value;
    // Match recognizable binary envelopes anywhere, including structuredContent.
    // Replace before descending so each envelope produces only one attachment.
    if (
      (block.type === "image" || block.type === "audio") &&
      (context === "block" || Predicate.isString(block.data))
    ) {
      return attachment(block, block.type, Predicate.isString(block.data) ? block.data : undefined);
    }
    if (Predicate.isString(block.blob) || (context === "resource" && block.blob !== undefined)) {
      return attachment(block, "resource", Predicate.isString(block.blob) ? block.blob : undefined);
    }
    if (Predicate.isString(block.base64)) return attachment(block, "unsupported", block.base64);
    if (context === "block") {
      if (block.type === "resource_link") return attachment(block, "link");
      if (block.type !== "text" && !(block.type === "resource" && block.resource !== undefined))
        return attachment(block, "unsupported");
    }
    return Object.fromEntries(
      Object.entries(block).map(([key, item]) => {
        let childContext: ContentContext;
        if (context === "result" && jsonArray(item)) {
          if (input.action === "tools.call" && key === "content") childContext = "block";
          if (input.action === "resources.read" && key === "contents") childContext = "resource";
          if (input.action === "prompts.get" && key === "messages") childContext = "message";
        } else if (context === "message" && key === "content") {
          // Prompt roles remain data. No message is submitted to a conversation.
          childContext = "block";
        } else if (context === "block" && block.type === "resource" && key === "resource") {
          childContext = "resource";
        }
        return [key, normalize(item, childContext)];
      }),
    );
  };
  try {
    // The bounded copy charges discarded bytes and leaves the validated raw reply untouched.
    // Never parse strings: only JSON objects can be recognized as binary envelopes.
    const serialized = JSON.stringify(normalize(copy(input.reply.result, 0), "result"));
    const bounded = boundedNotices([...notices, ...(input.notices ?? []).slice(0, 16)]);
    // Count all privately retained strings and descriptors, not just the text projection.
    const bytes =
      utf8Bytes(serialized) +
      utf8Bytes(
        JSON.stringify({
          origin,
          attachments,
          images,
          notices: bounded,
          owner: input.owner,
          server: input.server,
        }),
      );
    if (bytes > MCP_RESULT_LIMITS.acceptedBytes) throw new RangeError("normalized limit");
    return Object.freeze({
      origin,
      serialized,
      attachments: Object.freeze(attachments),
      images: Object.freeze(images),
      notices: bounded,
      bytes,
      outputLimited: false,
    });
  } catch {
    return Object.freeze({
      origin,
      serialized: "null",
      attachments: [],
      images: [],
      notices: boundedNotices([
        "Completed output exceeded normalization limits and is not recoverable. Do not repeat the operation to recover its output.",
        ...notices,
      ]),
      bytes: 0,
      outputLimited: true,
    });
  }
};
