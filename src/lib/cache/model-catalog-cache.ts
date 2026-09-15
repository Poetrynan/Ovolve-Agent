/**

 * Model Catalog Cache — minimal agent runtime Architecture

 * Manages model metadata, token limits, pricing, and remote ETag / Last-Modified caching.

 */



export interface ModelSpecification {

  id: string;

  name: string;

  provider: string;

  contextWindow: number;

  maxOutputTokens: number;

  supportsVision: boolean;

  supportsThinking: boolean;

  supportsPromptCache: boolean;

  cost: {

    input: number; // $ per 1M tokens

    output: number;

    cacheRead: number;

    cacheWrite: number;

  };

}



export interface ModelCatalogEntry {

  models: ModelSpecification[];

  lastModified?: number;

  checkedAt?: number;

  etag?: string;

}



export interface ModelCatalogStore {

  read(providerId: string): Promise<ModelCatalogEntry | undefined>;

  write(providerId: string, entry: ModelCatalogEntry): Promise<void>;

  delete(providerId: string): Promise<void>;

}



export const BUILTIN_MODEL_CATALOG: ModelSpecification[] = [

  {

    id: 'deepseek-chat',

    name: 'DeepSeek-V3',

    provider: 'deepseek',

    contextWindow: 128_000,

    maxOutputTokens: 8_192,

    supportsVision: false,

    supportsThinking: false,

    supportsPromptCache: true,

    cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },

  },

  {

    id: 'deepseek-reasoner',

    name: 'DeepSeek-R1',

    provider: 'deepseek',

    contextWindow: 128_000,

    maxOutputTokens: 8_192,

    supportsVision: false,

    supportsThinking: true,

    supportsPromptCache: true,

    cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },

  },

  {

    id: 'claude-3-7-sonnet',

    name: 'Claude 3.7 Sonnet',

    provider: 'anthropic',

    contextWindow: 200_000,

    maxOutputTokens: 8_192,

    supportsVision: true,

    supportsThinking: true,

    supportsPromptCache: true,

    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },

  },

  {

    id: 'gpt-4o',

    name: 'GPT-4o',

    provider: 'openai',

    contextWindow: 128_000,

    maxOutputTokens: 16_384,

    supportsVision: true,

    supportsThinking: false,

    supportsPromptCache: true,

    cost: { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 2.5 },

  },

];



const LOCAL_STORAGE_KEY_PREFIX = 'ovolve_model_catalog:';



export class LocalStorageModelCatalogStore implements ModelCatalogStore {

  async read(providerId: string): Promise<ModelCatalogEntry | undefined> {

    try {

      const raw = localStorage.getItem(LOCAL_STORAGE_KEY_PREFIX + providerId);

      if (!raw) return undefined;

      return JSON.parse(raw) as ModelCatalogEntry;

    } catch {

      return undefined;

    }

  }



  async write(providerId: string, entry: ModelCatalogEntry): Promise<void> {

    try {

      localStorage.setItem(LOCAL_STORAGE_KEY_PREFIX + providerId, JSON.stringify(entry));

    } catch {

      // Storage full or unavailable

    }

  }



  async delete(providerId: string): Promise<void> {

    try {

      localStorage.removeItem(LOCAL_STORAGE_KEY_PREFIX + providerId);

    } catch {

      // Ignore

    }

  }

}



/**

 * Global Model Catalog Manager with Cache TTL

 */

export class ModelCatalogManager {

  private static instance: ModelCatalogManager;

  private readonly store: ModelCatalogStore;

  private cacheTTLMs = 60 * 60 * 1000; // 1 hour



  private constructor(store: ModelCatalogStore = new LocalStorageModelCatalogStore()) {

    this.store = store;

  }



  static getInstance(): ModelCatalogManager {

    if (!ModelCatalogManager.instance) {

      ModelCatalogManager.instance = new ModelCatalogManager();

    }

    return ModelCatalogManager.instance;

  }



  async listModels(providerId = 'all', options: { forceRefresh?: boolean } = {}): Promise<ModelSpecification[]> {

    if (providerId === 'all') {

      return BUILTIN_MODEL_CATALOG;

    }



    if (!options.forceRefresh) {

      const cached = await this.store.read(providerId);

      if (cached && cached.checkedAt && Date.now() - cached.checkedAt < this.cacheTTLMs) {

        return cached.models;

      }

    }



    // Default to filtered builtins and write to cache

    const filtered = BUILTIN_MODEL_CATALOG.filter((m) => m.provider === providerId);

    await this.store.write(providerId, {

      models: filtered,

      checkedAt: Date.now(),

    });

    return filtered;

  }



  getModel(modelId: string): ModelSpecification | undefined {

    return BUILTIN_MODEL_CATALOG.find((m) => m.id === modelId || m.name.toLowerCase() === modelId.toLowerCase());

  }

}

