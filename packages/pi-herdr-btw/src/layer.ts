import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { HerdrClient } from "./boundary/herdr-client.ts";
import { HerdrBtwLinkStore } from "./boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "./boundary/host-session.ts";
import type { HerdrBtwLinkOwner } from "./btw/link.ts";
import { HerdrBtwService } from "./btw/service.ts";

export interface HerdrBtwLayerInput extends HerdrBtwSessionInput {
  readonly ctx: ExtensionContext;
  readonly linkOwner: HerdrBtwLinkOwner;
}

export const herdrBtwLayer = (pi: ExtensionAPI, input: HerdrBtwLayerInput) =>
  Layer.effect(HerdrBtwService, HerdrBtwService.make(input)).pipe(
    Layer.provide(
      Layer.mergeAll(
        HerdrClient.layer(input.environment),
        HerdrBtwLinkStore.layer(pi, input.ctx, input.linkOwner),
      ),
    ),
  );
