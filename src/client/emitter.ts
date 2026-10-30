type Handler<T> = (payload: T) => void;

/** A small typed event emitter. `on` returns a function that removes the handler. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        (handler as Handler<Events[K]>)(payload);
      } catch (error) {
        // One broken listener should not stop the conversation for the others.
        console.error(`[neocortex] "${String(event)}" handler threw:`, error);
      }
    }
  }
}
