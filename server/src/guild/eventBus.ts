import type { GuildEvent } from "./types.js";

type EventHandler = (event: GuildEvent) => void;

class GuildEventBus {
  private handlers = new Map<GuildEvent["type"], Set<EventHandler>>();
  private globalHandlers = new Set<EventHandler>();

  emit(event: GuildEvent): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) handler(event);
    }
    for (const handler of this.globalHandlers) handler(event);
  }

  on(type: GuildEvent["type"], handler: EventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  off(type: GuildEvent["type"], handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /** Listen to all event types */
  onAll(handler: EventHandler): void {
    this.globalHandlers.add(handler);
  }

  offAll(handler: EventHandler): void {
    this.globalHandlers.delete(handler);
  }
}

export const guildEventBus = new GuildEventBus();
