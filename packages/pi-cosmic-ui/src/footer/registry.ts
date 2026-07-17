import type { CosmicFooterContribution, CosmicFooterSurfaceContribution } from "../protocol.ts";

export class FooterContributionRegistry {
  private readonly contributions = new Map<string, Map<string, CosmicFooterContribution>>();
  private requestRender: (() => void) | undefined;

  setRenderRequest(requestRender: (() => void) | undefined): void {
    if (this.requestRender === requestRender) return;
    this.requestRender = requestRender;
    for (const contribution of this.list()) {
      if (contribution.kind !== "surface") continue;
      if (requestRender) contribution.attach?.({ requestRender });
      else contribution.detach?.();
    }
  }

  upsert(owner: string, contribution: CosmicFooterContribution): void {
    const owned = this.contributions.get(owner) ?? new Map<string, CosmicFooterContribution>();
    const previous = owned.get(contribution.id);
    if (previous !== contribution && previous?.kind === "surface") previous.dispose?.();
    owned.set(contribution.id, contribution);
    this.contributions.set(owner, owned);
    if (contribution.kind === "surface" && previous !== contribution && this.requestRender)
      contribution.attach?.({ requestRender: this.requestRender });
    this.requestRender?.();
  }

  remove(owner: string, id?: string): void {
    const owned = this.contributions.get(owner);
    if (!owned) return;
    if (id !== undefined) {
      const contribution = owned.get(id);
      if (contribution?.kind === "surface") contribution.dispose?.();
      owned.delete(id);
      if (owned.size === 0) this.contributions.delete(owner);
    } else {
      for (const contribution of owned.values()) {
        if (contribution.kind === "surface") contribution.dispose?.();
      }
      this.contributions.delete(owner);
    }
    this.requestRender?.();
  }

  invalidate(owner?: string, id?: string): void {
    for (const [currentOwner, owned] of this.contributions) {
      if (owner !== undefined && currentOwner !== owner) continue;
      for (const [currentId, contribution] of owned) {
        if (id !== undefined && currentId !== id) continue;
        if (contribution.kind === "surface") contribution.invalidate?.();
      }
    }
    this.requestRender?.();
  }

  requestRenderNow(): void {
    this.requestRender?.();
  }

  list(): CosmicFooterContribution[] {
    return [...this.contributions.values()].flatMap((owned) => [...owned.values()]);
  }

  surfaces(): CosmicFooterSurfaceContribution[] {
    return this.list().filter(
      (contribution): contribution is CosmicFooterSurfaceContribution =>
        contribution.kind === "surface",
    );
  }

  clear(): void {
    for (const contribution of this.list()) {
      if (contribution.kind === "surface") contribution.dispose?.();
    }
    this.contributions.clear();
    this.requestRender = undefined;
  }
}
