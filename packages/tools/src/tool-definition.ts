/**
 * @oa/tools — ToolDefinition Builder & Validator
 *
 * Provides a fluent builder pattern for constructing tool definitions
 * and validates them before registration.
 */

import {
  ToolDefinition,
  InputSchema,
  JSONSchemaProperty,
  ToolExecutionMode,
  ToolScope,
  ToolResult,
  ToolExecutionContext,
  ToolContent,
  ToolResultMetadata,
  ValidationResult,
  RiskLevel,
} from './types';

/**
 * Builder for constructing ToolDefinition instances.
 *
 * @example
 * const tool = new ToolDefinitionBuilder('read_file', 'Read a file from disk')
 *   .addProperty('path', 'string', 'Path to the file', true)
 *   .addProperty('encoding', 'string', 'File encoding', false)
 *   .setRiskLevel(RiskLevel.LOW)
 *   .setExecutor(async (args, ctx) => { ... })
 *   .build();
 */
export class ToolDefinitionBuilder {
  private _name: string;
  private _description: string;
  private _properties: Record<string, JSONSchemaProperty> = {};
  private _required: string[] = [];
  private _executionMode: ToolExecutionMode = ToolExecutionMode.PARALLEL;
  private _riskLevel: RiskLevel = RiskLevel.MEDIUM;
  private _scope: ToolScope = ToolScope.GLOBAL;
  private _agentId?: string;
  private _sessionId?: string;
  private _requiresConfirmation = false;
  private _timeoutMs = 30000;
  private _retryable = false;
  private _maxRetries = 3;
  private _metadata?: Record<string, unknown>;
  private _executor?: (args: unknown, context: ToolExecutionContext) => Promise<ToolResult>;

  constructor(name: string, description: string) {
    this._name = name;
    this._description = description;
  }

  /**
   * Add a parameter property to the input schema.
   */
  addProperty(
    name: string,
    type: JSONSchemaProperty['type'],
    description?: string,
    required = false,
    options?: Omit<JSONSchemaProperty, 'type' | 'description'>
  ): this {
    this._properties[name] = { type, description, ...options };
    if (required) {
      this._required.push(name);
    }
    return this;
  }

  /**
   * Add a string property.
   */
  addString(
    name: string,
    description?: string,
    required = false,
    options?: Omit<JSONSchemaProperty, 'type' | 'description'>
  ): this {
    return this.addProperty(name, 'string', description, required, options);
  }

  /**
   * Add a number property.
   */
  addNumber(
    name: string,
    description?: string,
    required = false,
    options?: Omit<JSONSchemaProperty, 'type' | 'description'>
  ): this {
    return this.addProperty(name, 'number', description, required, options);
  }

  /**
   * Add a boolean property.
   */
  addBoolean(
    name: string,
    description?: string,
    required = false,
    options?: Omit<JSONSchemaProperty, 'type' | 'description'>
  ): this {
    return this.addProperty(name, 'boolean', description, required, options);
  }

  /**
   * Add an array property.
   */
  addArray(
    name: string,
    description?: string,
    required = false,
    items?: JSONSchemaProperty,
    options?: Omit<JSONSchemaProperty, 'type' | 'description' | 'items'>
  ): this {
    return this.addProperty(name, 'array', description, required, { ...options, items });
  }

  /**
   * Add an object property.
   */
  addObject(
    name: string,
    description?: string,
    required = false,
    properties?: Record<string, JSONSchemaProperty>,
    options?: Omit<JSONSchemaProperty, 'type' | 'description' | 'properties'>
  ): this {
    return this.addProperty(name, 'object', description, required, { ...options, properties });
  }

  /**
   * Set the required fields explicitly.
   */
  setRequired(fields: string[]): this {
    this._required = fields;
    return this;
  }

  /**
   * Set the execution mode.
   */
  setExecutionMode(mode: ToolExecutionMode): this {
    this._executionMode = mode;
    return this;
  }

  /**
   * Set the risk level.
   */
  setRiskLevel(level: RiskLevel): this {
    this._riskLevel = level;
    return this;
  }

  /**
   * Set the scope.
   */
  setScope(scope: ToolScope, agentId?: string, sessionId?: string): this {
    this._scope = scope;
    this._agentId = agentId;
    this._sessionId = sessionId;
    return this;
  }

  /**
   * Set whether confirmation is required.
   */
  setRequiresConfirmation(required: boolean): this {
    this._requiresConfirmation = required;
    return this;
  }

  /**
   * Set the timeout.
   */
  setTimeout(timeoutMs: number): this {
    this._timeoutMs = timeoutMs;
    return this;
  }

  /**
   * Set retry behavior.
   */
  setRetryable(retryable: boolean, maxRetries = 3): this {
    this._retryable = retryable;
    this._maxRetries = maxRetries;
    return this;
  }

  /**
   * Set metadata.
   */
  setMetadata(metadata: Record<string, unknown>): this {
    this._metadata = metadata;
    return this;
  }

  /**
   * Set the executor function.
   */
  setExecutor(
    executor: (args: unknown, context: ToolExecutionContext) => Promise<ToolResult>
  ): this {
    this._executor = executor;
    return this;
  }

  /**
   * Build the ToolDefinition.
   */
  build(): ToolDefinition {
    if (!this._executor) {
      throw new Error(`ToolDefinition "${this._name}" must have an executor function`);
    }

    const inputSchema: InputSchema = {
      type: 'object',
      properties: this._properties,
      required: this._required.length > 0 ? this._required : undefined,
    };

    return {
      name: this._name,
      description: this._description,
      inputSchema,
      executionMode: this._executionMode,
      riskLevel: this._riskLevel,
      scope: this._scope,
      agentId: this._agentId,
      sessionId: this._sessionId,
      requiresConfirmation: this._requiresConfirmation,
      timeoutMs: this._timeoutMs,
      retryable: this._retryable,
      maxRetries: this._maxRetries,
      metadata: this._metadata,
      execute: this._executor,
    };
  }
}

/**
 * Validate a ToolDefinition for correctness.
 */
export function validateToolDefinition(definition: ToolDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Name validation.
  if (!definition.name || definition.name.trim() === '') {
    errors.push('Tool name is required');
  } else if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(definition.name)) {
    errors.push(
      'Tool name must start with a letter and contain only alphanumeric characters, underscores, or hyphens'
    );
  }

  // MCP tool name validation.
  if (definition.name.startsWith('mcp__')) {
    const parts = definition.name.split('__');
    if (parts.length !== 3) {
      warnings.push('MCP tool names should follow the pattern: mcp__<server>__<tool>');
    }
  }

  // Description validation.
  if (!definition.description || definition.description.trim() === '') {
    errors.push('Tool description is required');
  } else if (definition.description.length < 10) {
    warnings.push('Tool description should be at least 10 characters for LLM comprehension');
  }

  // Input schema validation.
  if (!definition.inputSchema) {
    errors.push('Input schema is required');
  } else {
    if (definition.inputSchema.type !== 'object') {
      errors.push('Input schema type must be "object"');
    }
    if (!definition.inputSchema.properties) {
      errors.push('Input schema must have properties');
    }
  }

  // Executor validation.
  if (!definition.execute) {
    errors.push('Tool executor function is required');
  } else if (typeof definition.execute !== 'function') {
    errors.push('Tool executor must be a function');
  }

  // Timeout validation.
  if (definition.timeoutMs <= 0) {
    errors.push('Timeout must be a positive number');
  } else if (definition.timeoutMs > 300000) {
    warnings.push('Timeout exceeds 5 minutes — consider if this is intentional');
  }

  // Scope validation.
  if (definition.scope === ToolScope.AGENT && !definition.agentId) {
    errors.push('AGENT scope requires an agentId');
  }
  if (definition.scope === ToolScope.SESSION && !definition.sessionId) {
    errors.push('SESSION scope requires a sessionId');
  }

  // Retry validation.
  if (definition.retryable && definition.maxRetries < 1) {
    errors.push('Retryable tools must have maxRetries >= 1');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Create a successful tool result.
 */
export function createSuccessResult(
  content: ToolContent | ToolContent[],
  metadata?: Partial<ToolResultMetadata>
): ToolResult {
  const contents = Array.isArray(content) ? content : [content];
  return {
    success: true,
    content: contents,
    metadata: {
      toolName: metadata?.toolName ?? '',
      durationMs: metadata?.durationMs ?? 0,
      retryCount: metadata?.retryCount ?? 0,
      truncated: metadata?.truncated ?? false,
      tokenCount: metadata?.tokenCount,
      extra: metadata?.extra,
    },
  };
}

/**
 * Create a failed tool result.
 */
export function createErrorResult(
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
  metadata?: Partial<ToolResultMetadata>
): ToolResult {
  return {
    success: false,
    content: [{ type: 'error', message, code }],
    error: { code, message, retryable, details },
    metadata: {
      toolName: metadata?.toolName ?? '',
      durationMs: metadata?.durationMs ?? 0,
      retryCount: metadata?.retryCount ?? 0,
      truncated: metadata?.truncated ?? false,
      tokenCount: metadata?.tokenCount,
      extra: metadata?.extra,
    },
  };
}

/**
 * Create a text content block.
 */
export function textContent(text: string): ToolContent {
  return { type: 'text', text };
}

/**
 * Create a JSON content block.
 */
export function jsonContent(data: unknown): ToolContent {
  return { type: 'json', data };
}

/**
 * Generate a unique tool call ID.
 */
export function generateCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
