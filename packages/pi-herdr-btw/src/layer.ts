import * as Layer from "effect/Layer";
import { HerdrClient } from "./boundary/herdr-client.ts";
import { HerdrBtwService } from "./btw/service.ts";

/** Session-scoped composition root for the BTW command service. */
export const makeHerdrBtwLayer = (input: Parameters<typeof HerdrBtwService.make>[0]) =>
  Layer.effect(HerdrBtwService, HerdrBtwService.make(input)).pipe(
    Layer.provide(HerdrClient.layer(input.environment)),
  );
