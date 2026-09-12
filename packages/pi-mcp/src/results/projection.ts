import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import {
  MCP_INLINE_BYTES,
  type McpGatewayExecution,
  type McpGatewayReply,
  type McpProjectionOptions,
} from "../tools/model.ts";
import {
  MCP_MIN_PROJECTION_BYTES,
  MCP_RESULT_LIMITS,
  originJson,
  type McpPreparedResult,
  type McpResultRead,
  type McpRetentionOutcome,
  type McpStoredImage,
} from "./model.ts";
import { boundedNotices, prefixBytes, utf8Bytes } from "./normalize.ts";

export const projectionBudget = (
  options: McpProjectionOptions,
): Effect.Effect<number, McpBoundaryError> =>
  Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes >= MCP_MIN_PROJECTION_BYTES
    ? Effect.succeed(Math.min(Math.floor(options.maxOutputBytes), MCP_INLINE_BYTES))
    : Effect.fail(
        boundaryError(
          "output-limit",
          "completed",
          "Insufficient output allowance; reserve at least 512 bytes before dispatch.",
        ),
      );

// Reserve even the Code Mode execution wrapper. Native image data is charged separately.
const executionBytes = (reply: McpGatewayReply): number =>
  utf8Bytes(JSON.stringify({ reply, images: [] }));

// JSON escapes line breaks. Count those too so text is bounded if a host renders it decoded.
const withinLines = (text: string): boolean => {
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n" || (text[index] === "\\" && text[index + 1] === "n")) {
      if (++lines > MCP_RESULT_LIMITS.lines) return false;
    }
  }
  return true;
};

const fitsEnvelope = (reply: McpGatewayReply, budget: number): boolean => {
  const serialized = JSON.stringify({ reply, images: [] });
  return utf8Bytes(serialized) <= budget && withinLines(serialized);
};

const addNotices = (
  reply: McpGatewayReply,
  notices: ReadonlyArray<string>,
  budget: number,
): McpGatewayReply => {
  const chosen: string[] = [];
  for (const notice of boundedNotices(notices)) {
    const candidate = { ...reply, notices: [...chosen, notice] };
    if (!fitsEnvelope(candidate, budget)) break;
    chosen.push(notice);
  }
  return { ...reply, notices: chosen };
};

const addImages = (
  reply: McpGatewayReply,
  candidates: ReadonlyArray<McpStoredImage>,
  options: McpProjectionOptions,
): McpGatewayExecution => {
  const images: McpGatewayExecution["images"][number][] = [];
  let bytes = 0;
  if (options.images) {
    for (const image of candidates) {
      // Native attachments have a separate allowance from the text/JSON envelope.
      if (
        images.length >= MCP_RESULT_LIMITS.nativeImages ||
        bytes + image.data.length > MCP_RESULT_LIMITS.acceptedBytes
      )
        continue;
      images.push({ type: "image", mimeType: image.mimeType, data: image.data });
      bytes += image.data.length;
    }
  }
  return { reply, images };
};

/** Pure projection work is separate from the retention/publication commit. */
export const projectPrepared = (
  prepared: McpPreparedResult,
  retention: McpRetentionOutcome,
  options: McpProjectionOptions,
  read?: McpResultRead,
): Effect.Effect<McpGatewayExecution, McpBoundaryError> =>
  Effect.gen(function* () {
    const budget = yield* projectionBudget(options);
    const retained = retention.status === "retained";
    const isRead = read !== undefined;
    const isError = isRead
      ? false
      : prepared.origin.isError ||
        prepared.origin.outputValidation === "failed" ||
        prepared.origin.outputValidation === "unavailable" ||
        prepared.outputLimited ||
        !retained;
    let base: McpGatewayReply = {
      action: isRead ? "result.read" : prepared.origin.action,
      outcome: "completed",
      isError,
      data: { origin: originJson(prepared.origin) },
      notices: [],
    };
    if (retained) base = { ...base, resultId: retention.resultId };
    const notices = [
      ...(!retained
        ? ["Completed output was not retained and is not recoverable by result ID."]
        : []),
      ...prepared.notices,
    ];
    const nativeOmitted =
      !isRead && options.images && prepared.images.length > MCP_RESULT_LIMITS.nativeImages;
    if (nativeOmitted)
      notices.unshift(
        retained
          ? "Only the first 8 native images are shown; use result.read attachment for the remaining images."
          : "Completed output was not retained; some native images were omitted.",
      );
    if (read?.attachment !== undefined) {
      const descriptor = prepared.attachments[read.attachment];
      const image = prepared.images.find((candidate) => candidate.index === read.attachment);
      if (descriptor === undefined)
        return yield* boundaryError("not-found", "not-sent", "Attachment is not available.");
      if (image === undefined)
        return yield* boundaryError(
          "unsupported",
          "not-sent",
          "Only stored supported images can be read; resource links are never followed.",
        );
      let reply = {
        ...base,
        data: { origin: originJson(prepared.origin), attachment: { ...descriptor } },
      };
      if (!fitsEnvelope(reply, budget)) {
        const { uri: _uri, ...compact } = descriptor;
        reply = { ...base, data: { origin: originJson(prepared.origin), attachment: compact } };
        notices.unshift("Attachment URI omitted to fit the allowance.");
      }
      return addImages(addNotices(reply, notices, budget), [image], options);
    }
    if (
      !isRead &&
      !prepared.outputLimited &&
      utf8Bytes(prepared.serialized) + executionBytes(base) + 32 <= budget &&
      withinLines(prepared.serialized)
    ) {
      const result = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
        prepared.serialized,
      ).pipe(
        Effect.mapError(() =>
          boundaryError("protocol", "completed", "Normalized output could not be projected."),
        ),
      );
      const full = { ...base, data: { origin: originJson(prepared.origin), result } };
      const reply = addNotices(full, notices, budget);
      if (fitsEnvelope(reply, budget) && (notices.length === 0 || reply.notices.length > 0))
        return addImages(reply, prepared.images, options);
    }
    const offset = read?.offset ?? 0;
    const limit = read?.limit ?? 50_000;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > prepared.serialized.length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50_000
    ) {
      return yield* boundaryError(
        "invalid-input",
        "not-sent",
        "Result slice offset or limit is invalid.",
      );
    }
    const code = prepared.serialized.charCodeAt(offset);
    const previous = prepared.serialized.charCodeAt(offset - 1);
    if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      return yield* boundaryError(
        "invalid-input",
        "not-sent",
        "Result offset splits a Unicode character; use the returned next offset.",
      );
    }
    const slice = (text: string): McpGatewayReply => {
      const next = offset + text.length;
      return {
        ...base,
        data: {
          origin: originJson(prepared.origin),
          format: "json",
          offset,
          next: next < prepared.serialized.length ? next : null,
          total: prepared.serialized.length,
          text,
          truncated: !isRead || next < prepared.serialized.length || offset > 0,
        },
      };
    };
    const limitedNotices = [
      ...(!retained ? notices : []),
      ...(!isRead && retained
        ? ["Output is limited; use result.read with the returned ID and next offset."]
        : []),
      ...(retained ? notices : []),
    ];
    // Keep one short operational notice before using spare bytes for text or extra notices.
    const firstNotice = nativeOmitted ? notices[0] : limitedNotices[0];
    const mandatory = firstNotice === undefined ? [] : [prefixBytes(firstNotice, 128)];
    const empty = { ...slice(""), notices: mandatory };
    if (!fitsEnvelope(empty, budget)) {
      // A bounded fallback preserves certainty and a valid recovery ID, never raw output.
      const compact = addNotices(
        { ...base, data: { origin: originJson(prepared.origin), omitted: true } },
        ["Output omitted; use result.read if an ID is present.", ...notices],
        budget,
      );
      return addImages(compact, isRead ? [] : prepared.images, options);
    }
    let end = offset + Math.min(limit, budget);
    const last = prepared.serialized.charCodeAt(end - 1);
    const following = prepared.serialized.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) {
      // A one-unit request still makes progress on a two-unit Unicode scalar.
      end += end === offset + 1 ? 1 : -1;
    }
    const source = prepared.serialized.slice(offset, end);
    let low = 0;
    let high = utf8Bytes(source);
    let text = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = prefixBytes(source, middle);
      const reply = { ...slice(candidate), notices: mandatory };
      if (fitsEnvelope(reply, budget)) {
        text = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    return addImages(
      addNotices(slice(text), [...mandatory, ...limitedNotices], budget),
      isRead ? [] : prepared.images,
      options,
    );
  });
