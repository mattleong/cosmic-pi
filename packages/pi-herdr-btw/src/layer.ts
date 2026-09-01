import * as Layer from "effect/Layer";
import { HerdrClient } from "./boundary/herdr-client.ts";
import type { HerdrBtwLinkStore } from "./boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "./boundary/host-session.ts";
import { HerdrBtwService, makeHerdrBtwService } from "./btw/service.ts";

export interface HerdrBtwLayerInput extends HerdrBtwSessionInput {
  readonly linkStore: HerdrBtwLinkStore;
}

/** Session-scoped composition root for the BTW command service. */
export const makeHerdrBtwLayer = (input: HerdrBtwLayerInput) =>
  Layer.effect(HerdrBtwService, makeHerdrBtwService(input)).pipe(
    Layer.provide(HerdrClient.layer(input.environment)),
  );
