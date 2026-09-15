/**
 * @oa/hooks — Hook System for OvolveAgent
 *
 * Provides a lightweight hook system for extending agent behavior.
 * Complements the plugin system with simpler callback-based hooks.
 */

export type HookCallback<T = unknown> = (payload: T) => Promise<T | void> | T | void;

export interface HookSubscription {
  id: string;
  callback: HookCallback;
  priority: number;
}

export interface Hook<T = unknown> {
  name: string;
  subscribe(callback: HookCallback<T>, priority?: number): () => void;
  emit(payload: T): Promise<T>;
  clear(): void;
}

export function createHook<T = unknown>(name: string): Hook<T> {
  const subscriptions: HookSubscription[] = [];

  return {
    name,
    subscribe(callback: HookCallback<T>, priority = 100) {
      const id = crypto.randomUUID();
      subscriptions.push({ id, callback, priority });
      subscriptions.sort((a, b) => a.priority - b.priority);

      return () => {
        const index = subscriptions.findIndex((s) => s.id === id);
        if (index !== -1) subscriptions.splice(index, 1);
      };
    },
    async emit(payload: T): Promise<T> {
      let current = payload;
      for (const sub of subscriptions) {
        const result = await sub.callback(current);
        if (result !== undefined) {
          current = result as T;
        }
      }
      return current;
    },
    clear() {
      subscriptions.length = 0;
    },
  };
}

export interface HookRegistry {
  createHook<T>(name: string): Hook<T>;
  getHook<T>(name: string): Hook<T> | undefined;
  removeHook(name: string): boolean;
  listHooks(): string[];
}

export class HookRegistryImpl implements HookRegistry {
  private hooks: Map<string, Hook> = new Map();

  createHook<T>(name: string): Hook<T> {
    const hook = createHook<T>(name);
    this.hooks.set(name, hook as Hook);
    return hook;
  }

  getHook<T>(name: string): Hook<T> | undefined {
    return this.hooks.get(name) as Hook<T> | undefined;
  }

  removeHook(name: string): boolean {
    return this.hooks.delete(name);
  }

  listHooks(): string[] {
    return Array.from(this.hooks.keys());
  }
}

export function createHookRegistry(): HookRegistry {
  return new HookRegistryImpl();
}

// Global hook registry
let globalHookRegistry: HookRegistry | null = null;

export function getGlobalHookRegistry(): HookRegistry {
  if (!globalHookRegistry) {
    globalHookRegistry = createHookRegistry();
  }
  return globalHookRegistry;
}
