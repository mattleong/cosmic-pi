import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { PiApi } from "./pi-api.ts";

/**
 * Creates one host-owned Effect runtime for a pi extension.
 *
 * Construct this from `session_start` (or lazily from the first session-bound
 * operation) and dispose it during `session_shutdown`. Application code should
 * not create nested runtimes.
 */
export const makePiRuntime = (pi: ExtensionAPI) => ManagedRuntime.make(PiApi.layer(pi));
