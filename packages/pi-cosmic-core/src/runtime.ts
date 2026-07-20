import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { PiApi } from "./pi-api.ts";

/**
 * Creates one host-owned Effect runtime for a pi extension.
 *
 * Construct this from `session_start` (or lazily from the first session-bound
 * operation) and dispose it during `session_shutdown`. Application code should
 * not create nested runtimes.
 */
export function makePiRuntime(pi: ExtensionAPI): ManagedRuntime.ManagedRuntime<PiApi, never>;
export function makePiRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer: Layer.Layer<R, E>,
): ManagedRuntime.ManagedRuntime<PiApi | R, E>;
export function makePiRuntime<R, E>(pi: ExtensionAPI, applicationLayer?: Layer.Layer<R, E>) {
  const piLayer = PiApi.layer(pi);
  return ManagedRuntime.make(applicationLayer ? Layer.merge(piLayer, applicationLayer) : piLayer);
}
