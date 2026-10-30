import type { Interactable } from "../core/types";

/**
 * The things in a scene a character can perceive and act on. Register them here
 * and pass `scene.toMetadata()` with each turn; actions come back with the
 * `targetId` of the entity they apply to.
 *
 * The server proxy drops browser-sent metadata unless it is created with
 * `allowClientContext: true`. For anything that matters (prices, inventory,
 * permissions), build the context on the server with `buildContext` instead.
 */
export class Interactables {
  private items = new Map<string, Interactable>();

  set(item: Interactable): this {
    this.items.set(item.id, { ...item });
    return this;
  }

  update(id: string, patch: Partial<Omit<Interactable, "id">>): this {
    const current = this.items.get(id);
    if (current) this.items.set(id, { ...current, ...patch });
    return this;
  }

  remove(id: string): this {
    this.items.delete(id);
    return this;
  }

  get(id: string): Interactable | undefined {
    return this.items.get(id);
  }

  /** Marks one entity as what the player is focused on, and clears the rest. */
  focus(id: string | null): this {
    for (const [key, item] of this.items) this.items.set(key, { ...item, isSubject: key === id });
    return this;
  }

  clear(): void {
    this.items.clear();
  }

  toMetadata(): Interactable[] {
    return [...this.items.values()];
  }
}
