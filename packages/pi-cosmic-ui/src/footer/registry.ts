import type { CosmicFooterContribution, CosmicFooterSurfaceContribution } from "../protocol.ts";

function isolate(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Third-party footer contributions cannot break host cleanup or rendering.
  }
}

export class FooterContributionRegistry {
  private readonly contributions = new Map<string, Map<string, CosmicFooterContribution>>();
  private requestRender: (() => void) | undefined;

  private renderNow(): void {
    isolate(this.requestRender);
  }

  private attach(surface: CosmicFooterSurfaceContribution): void {
    if (!this.requestRender) return;
    isolate(() => surface.attach?.({ requestRender: () => this.renderNow() }));
  }

  private detach(surface: CosmicFooterSurfaceContribution): void {
    if (!this.requestRender) return;
    isolate(surface.detach?.bind(surface));
  }

  private release(surface: CosmicFooterSurfaceContribution): void {
    this.detach(surface);
    isolate(surface.dispose?.bind(surface));
  }

  setRenderRequest(requestRender: (() => void) | undefined): void {
    if (this.requestRender === requestRender) return;
    const wasAttached = this.requestRender !== undefined;
    if (wasAttached) {
      for (const surface of this.surfaces()) this.detach(surface);
    }
    this.requestRender = requestRender;
    if (requestRender) {
      for (const surface of this.surfaces()) this.attach(surface);
    }
  }

  upsert(owner: string, contribution: CosmicFooterContribution): void {
    const owned = this.contributions.get(owner) ?? new Map<string, CosmicFooterContribution>();
    const previous = owned.get(contribution.id);
    if (previous !== contribution && previous?.kind === "surface") this.release(previous);
    owned.set(contribution.id, contribution);
    this.contributions.set(owner, owned);
    if (contribution.kind === "surface" && previous !== contribution) this.attach(contribution);
    this.renderNow();
  }

  remove(owner: string, id?: string): void {
    const owned = this.contributions.get(owner);
    if (!owned) return;
    if (id !== undefined) {
      const contribution = owned.get(id);
      if (contribution?.kind === "surface") this.release(contribution);
      owned.delete(id);
      if (owned.size === 0) this.contributions.delete(owner);
    } else {
      for (const contribution of owned.values()) {
        if (contribution.kind === "surface") this.release(contribution);
      }
      this.contributions.delete(owner);
    }
    this.renderNow();
  }

  invalidate(owner?: string, id?: string): void {
    for (const [currentOwner, owned] of this.contributions) {
      if (owner !== undefined && currentOwner !== owner) continue;
      for (const [currentId, contribution] of owned) {
        if (id !== undefined && currentId !== id) continue;
        if (contribution.kind === "surface") isolate(contribution.invalidate?.bind(contribution));
      }
    }
    this.renderNow();
  }

  requestRenderNow(): void {
    this.renderNow();
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
    for (const surface of this.surfaces()) this.release(surface);
    this.contributions.clear();
    this.requestRender = undefined;
  }
}
