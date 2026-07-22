import { extractAccountIdFromJwt } from "../codex-auth.ts";
import {
  buildRequest,
  dataUrlParts,
  extractImageFromEvent,
  imageMimeType,
} from "./helpers.ts";
import {
  CODEX_RESPONSES_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  OPENAI_IMAGE_COMMAND,
  OPENAI_IMAGE_TOOL,
  TOOL_PARAMS,
} from "./types.ts";

export const _imageTest = {
  TOOL_PARAMS,
  CODEX_RESPONSES_URL,
  DEFAULT_TIMEOUT_MS,
  OPENAI_IMAGE_TOOL,
  OPENAI_IMAGE_COMMAND,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  extractAccountIdFromJwt,
  imageMimeType,
  dataUrlParts,
  extractImageFromEvent,
  buildRequest,
};
