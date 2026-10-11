import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class PiApi extends Context.Service<PiApi, ExtensionAPI>()(
  "pi-cosmic-core/runtime/pi-api/PiApi",
) {
  static readonly layer = (pi: ExtensionAPI): Layer.Layer<PiApi> => Layer.succeed(this, pi);
}
