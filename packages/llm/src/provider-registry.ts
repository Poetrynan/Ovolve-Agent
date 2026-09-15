/**
 * Provider registration and discovery.
 *
 * Manages the set of available LLM providers, handles auto-selection based
 * on priority / model availability, and supports failover between providers.
 */

import type { ProviderConfig, ProviderType, ModelConfig, ProviderAdapter } from './types.js';

export interface ProviderRegistryOptions {
  /** Called when a provider is registered. */
  onRegister?: (config: ProviderConfig) => void;
  /** Called when failover occurs. */
  onFailover?: (from: string, to: string, reason: string) => void;
}

/**
 * ProviderRegistry holds all configured providers and their adapters.
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>();
  private adapters = new Map<string, ProviderAdapter>();
  private failureCounts = new Map<string, number>();
  private consecutiveFailures = new Map<string, number>();
  private options: ProviderRegistryOptions;

  constructor(options: ProviderRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Register a provider with its adapter.
   */
  register(config: ProviderConfig, adapter: ProviderAdapter): void {
    this.providers.set(config.id, config);
    this.adapters.set(config.id, adapter);
    this.failureCounts.set(config.id, 0);
    this.consecutiveFailures.set(config.id, 0);
    this.options.onRegister?.(config);
  }

  /**
   * Unregister a provider.
   */
  unregister(providerId: string): void {
    this.providers.delete(providerId);
    this.adapters.delete(providerId);
    this.failureCounts.delete(providerId);
    this.consecutiveFailures.delete(providerId);
  }

  /**
   * Get a provider's config by id.
   */
  getProvider(providerId: string): ProviderConfig | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get a provider's adapter by id.
   */
  getAdapter(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /**
   * Get all registered providers.
   */
  getAllProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all enabled providers sorted by priority.
   */
  getEnabledProviders(): ProviderConfig[] {
    return this.getAllProviders()
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find providers that support a given model id.
   */
  findProvidersForModel(modelId: string): ProviderConfig[] {
    return this.getEnabledProviders().filter((p) =>
      p.models.some((m) => m.id === modelId && m.status === 'active'),
    );
  }

  /**
   * Auto-select the best provider for a model based on priority and health.
   */
  autoSelectProvider(modelId: string, excludeIds: string[] = []): ProviderConfig | undefined {
    const candidates = this.findProvidersForModel(modelId).filter(
      (p) => !excludeIds.includes(p.id),
    );

    if (candidates.length === 0) return undefined;

    // Prefer providers with fewer consecutive failures.
    return candidates.sort((a, b) => {
      const aFails = this.consecutiveFailures.get(a.id) ?? 0;
      const bFails = this.consecutiveFailures.get(b.id) ?? 0;
      if (aFails !== bFails) return aFails - bFails;
      return a.priority - b.priority;
    })[0];
  }

  /**
   * Get a model's config from a provider.
   */
  getModel(providerId: string, modelId: string): ModelConfig | undefined {
    const provider = this.providers.get(providerId);
    return provider?.models.find((m) => m.id === modelId);
  }

  /**
   * Record a successful request (resets consecutive failure count).
   */
  recordSuccess(providerId: string): void {
    this.consecutiveFailures.set(providerId, 0);
  }

  /**
   * Record a failed request. Returns true if failover threshold reached.
   */
  recordFailure(providerId: string, threshold: number = 3): boolean {
    const total = (this.failureCounts.get(providerId) ?? 0) + 1;
    this.failureCounts.set(providerId, total);

    const consecutive = (this.consecutiveFailures.get(providerId) ?? 0) + 1;
    this.consecutiveFailures.set(providerId, consecutive);

    if (consecutive >= threshold) {
      // Reset consecutive count after triggering failover.
      this.consecutiveFailures.set(providerId, 0);
      return true;
    }
    return false;
  }

  /**
   * Get the next provider for failover, excluding the current one.
   */
  getNextProviderForFailover(
    currentProviderId: string,
    modelId: string,
  ): ProviderConfig | undefined {
    return this.autoSelectProvider(modelId, [currentProviderId]);
  }

  /**
   * Get failure statistics for a provider.
   */
  getFailureStats(providerId: string): { total: number; consecutive: number } {
    return {
      total: this.failureCounts.get(providerId) ?? 0,
      consecutive: this.consecutiveFailures.get(providerId) ?? 0,
    };
  }

  /**
   * Reset all failure counts.
   */
  resetFailures(): void {
    for (const id of this.consecutiveFailures.keys()) {
      this.consecutiveFailures.set(id, 0);
    }
  }

  /**
   * Check if a provider type is registered.
   */
  hasProviderType(type: ProviderType): boolean {
    return this.getAllProviders().some((p) => p.type === type);
  }

  /**
   * Get all providers of a given type.
   */
  getProvidersByType(type: ProviderType): ProviderConfig[] {
    return this.getAllProviders().filter((p) => p.type === type);
  }
}
