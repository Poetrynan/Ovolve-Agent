/**
 * @oa/tools — Search Tools (built-in)
 *
 * Search, grep, and find tools for discovering content across files.
 */

import { ToolDefinitionBuilder } from '../tool-definition';
import { ToolExecutionMode, ToolScope } from '../types';
import { RiskLevel } from '@oa/plugins';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../types';
import { createSuccessResult, createErrorResult, textContent, jsonContent } from '../tool-definition';

// ─── Grep Tool ────────────────────────────────────────────────────────────

/**
 * Arguments for the grep tool.
 */
export interface GrepArgs {
  /** Pattern to search for. */
  pattern: string;
  /** Directory or file to search in. */
  path?: string;
  /** Glob pattern to filter files. */
  glob?: string;
  /** Whether to use regex. */
  regex?: boolean;
  /** Whether to ignore case. */
  ignore_case?: boolean;
  /** Number of context lines. */
  context_lines?: number;
  /** Maximum number of results. */
  max_results?: number;
  /** Whether to show line numbers. */
  show_line_numbers?: boolean;
}

/**
 * A single grep match.
 */
export interface GrepMatch {
  file: string;
  line: number;
  column?: number;
  match: string;
  before_context?: string[];
  after_context?: string[];
}

/**
 * Create the grep tool definition.
 */
export function createGrepTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'grep',
    'Search for a pattern in files using grep-like functionality. Supports regex, case-insensitive search, and context lines.'
  )
    .addString('pattern', 'The pattern to search for.', true)
    .addString('path', 'Directory or file to search in. Defaults to current directory.', false)
    .addString('glob', 'Glob pattern to filter files (e.g., "*.ts").', false)
    .addBoolean('regex', 'Whether to treat pattern as regex. Defaults to true.', false)
    .addBoolean('ignore_case', 'Whether to ignore case. Defaults to false.', false)
    .addNumber('context_lines', 'Number of context lines to show. Defaults to 0.', false, {
      minimum: 0,
      maximum: 20,
    })
    .addNumber('max_results', 'Maximum number of results. Defaults to 100.', false, {
      minimum: 1,
      maximum: 10000,
    })
    .addBoolean('show_line_numbers', 'Whether to show line numbers. Defaults to true.', false)
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(60000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const {
        pattern,
        path = '.',
        glob,
        regex = true,
        ignore_case = false,
        context_lines = 0,
        max_results = 100,
        show_line_numbers = true,
      } = args as unknown as GrepArgs;

      try {
        context.pluginContext.logger.info(
          `grep: searching for "${pattern}" in "${path}"`
        );

        // In production: use ripgrep, glob, or Node.js fs API.
        // Placeholder.
        const matches: GrepMatch[] = [];

        // Simulated search result.
        const resultText =
          matches.length > 0
            ? matches
                .slice(0, max_results)
                .map((m) => {
                  const lineNum = show_line_numbers ? `${m.line}:` : '';
                  return `${m.file}:${lineNum}${m.match}`;
                })
                .join('\n')
            : `No matches found for "${pattern}" in "${path}".`;

        return createSuccessResult(
          [
            textContent(resultText),
            jsonContent({
              pattern,
              path,
              matches: matches.slice(0, max_results),
              totalMatches: matches.length,
              truncated: matches.length > max_results,
            }),
          ],
          { toolName: 'grep', tokenCount: Math.ceil(resultText.length / 4) }
        );
      } catch (err) {
        return createErrorResult(
          'GREP_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { pattern, path },
          { toolName: 'grep' }
        );
      }
    })
    .build();
}

// ─── Find Tool ────────────────────────────────────────────────────────────

/**
 * Arguments for the find tool.
 */
export interface FindArgs {
  /** Base directory to search from. */
  path?: string;
  /** Name pattern (glob). */
  name?: string;
  /** Type filter. */
  type?: 'file' | 'directory' | 'all';
  /** Maximum depth. */
  max_depth?: number;
  /** Whether to include hidden files. */
  include_hidden?: boolean;
  /** Size filter. */
  min_size?: number;
  max_size?: number;
  /** Modified time filter (seconds ago). */
  modified_within?: number;
}

/**
 * A single find result.
 */
export interface FindResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: Date;
}

/**
 * Create the find tool definition.
 */
export function createFindTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'find',
    'Find files and directories by name, type, size, or modification time.'
  )
    .addString('path', 'Base directory to search from. Defaults to current directory.', false)
    .addString('name', 'Name pattern (glob, e.g., "*.ts").', false)
    .addString('type', 'Type filter: "file", "directory", or "all". Defaults to "all".', false, {
      enum: ['file', 'directory', 'all'],
    })
    .addNumber('max_depth', 'Maximum directory depth. Defaults to unlimited.', false, {
      minimum: 1,
    })
    .addBoolean('include_hidden', 'Whether to include hidden files. Defaults to false.', false)
    .addNumber('min_size', 'Minimum file size in bytes.', false, { minimum: 0 })
    .addNumber('max_size', 'Maximum file size in bytes.', false, { minimum: 0 })
    .addNumber('modified_within', 'Only files modified within N seconds ago.', false, {
      minimum: 0,
    })
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(60000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const {
        path = '.',
        name,
        type = 'all',
        max_depth,
        include_hidden = false,
        min_size,
        max_size,
        modified_within,
      } = args as unknown as FindArgs;

      try {
        context.pluginContext.logger.info(`find: searching in "${path}"`);

        // In production: use fs.walk, glob, or fast-glob.
        // Placeholder.
        const results: FindResult[] = [];

        const resultText =
          results.length > 0
            ? results.map((r) => r.path).join('\n')
            : `No files found matching criteria in "${path}".`;

        return createSuccessResult(
          [
            textContent(resultText),
            jsonContent({
              path,
              results,
              count: results.length,
            }),
          ],
          { toolName: 'find', tokenCount: Math.ceil(resultText.length / 4) }
        );
      } catch (err) {
        return createErrorResult(
          'FIND_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { path },
          { toolName: 'find' }
        );
      }
    })
    .build();
}

// ─── Search Tool ──────────────────────────────────────────────────────────

/**
 * Arguments for the search tool.
 */
export interface SearchArgs {
  /** Search query. */
  query: string;
  /** Paths to search in. */
  paths?: string[];
  /** Whether to search file contents. */
  search_contents?: boolean;
  /** Whether to search file names. */
  search_names?: boolean;
  /** Maximum results. */
  max_results?: number;
  /** Fuzzy matching threshold (0-1). */
  fuzzy_threshold?: number;
}

/**
 * A single search result.
 */
export interface SearchResult {
  path: string;
  score: number;
  matches?: Array<{ line: number; text: string }>;
}

/**
 * Create the search tool definition.
 */
export function createSearchTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'search',
    'Search for files and content using a query. Supports both filename and content search with fuzzy matching.'
  )
    .addString('query', 'The search query.', true)
    .addArray('paths', 'Paths to search in. Defaults to current directory.', false, {
      type: 'string',
      description: 'A path to search in.',
    })
    .addBoolean('search_contents', 'Whether to search file contents. Defaults to true.', false)
    .addBoolean('search_names', 'Whether to search file names. Defaults to true.', false)
    .addNumber('max_results', 'Maximum number of results. Defaults to 20.', false, {
      minimum: 1,
      maximum: 1000,
    })
    .addNumber('fuzzy_threshold', 'Fuzzy matching threshold (0-1). Defaults to 0.6.', false, {
      minimum: 0,
      maximum: 1,
    })
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(60000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const {
        query,
        paths = ['.'],
        search_contents = true,
        search_names = true,
        max_results = 20,
        fuzzy_threshold = 0.6,
      } = args as unknown as SearchArgs;

      try {
        context.pluginContext.logger.info(
          `search: searching for "${query}" in ${paths.length} path(s)`
        );

        // In production: use a search library like fuse.js, ripgrep, or a custom index.
        // Placeholder.
        const results: SearchResult[] = [];

        const resultText =
          results.length > 0
            ? results
                .slice(0, max_results)
                .map((r) => `${r.path} (score: ${r.score.toFixed(2)})`)
                .join('\n')
            : `No results found for "${query}".`;

        return createSuccessResult(
          [
            textContent(resultText),
            jsonContent({
              query,
              paths,
              results: results.slice(0, max_results),
              totalResults: results.length,
            }),
          ],
          { toolName: 'search', tokenCount: Math.ceil(resultText.length / 4) }
        );
      } catch (err) {
        return createErrorResult(
          'SEARCH_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { query },
          { toolName: 'search' }
        );
      }
    })
    .build();
}

// ─── Glob Tool ────────────────────────────────────────────────────────────

/**
 * Arguments for the glob tool.
 */
export interface GlobArgs {
  /** Glob pattern. */
  pattern: string;
  /** Base directory. */
  path?: string;
  /** Whether to include directories. */
  include_directories?: boolean;
  /** Whether to follow symlinks. */
  follow_symlinks?: boolean;
}

/**
 * Create the glob tool definition.
 */
export function createGlobTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'glob',
    'Match files using glob patterns (e.g., "**/*.ts", "src/**/*.json").'
  )
    .addString('pattern', 'The glob pattern to match.', true)
    .addString('path', 'Base directory. Defaults to current directory.', false)
    .addBoolean('include_directories', 'Whether to include directories. Defaults to true.', false)
    .addBoolean('follow_symlinks', 'Whether to follow symlinks. Defaults to false.', false)
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const {
        pattern,
        path = '.',
        include_directories = true,
        follow_symlinks = false,
      } = args as unknown as GlobArgs;

      try {
        context.pluginContext.logger.info(
          `glob: matching pattern "${pattern}" in "${path}"`
        );

        // In production: use fast-glob or globby.
        // Placeholder.
        const matches: string[] = [];

        const resultText =
          matches.length > 0
            ? matches.join('\n')
            : `No files matched pattern "${pattern}" in "${path}".`;

        return createSuccessResult(
          [
            textContent(resultText),
            jsonContent({
              pattern,
              path,
              matches,
              count: matches.length,
            }),
          ],
          { toolName: 'glob', tokenCount: Math.ceil(resultText.length / 4) }
        );
      } catch (err) {
        return createErrorResult(
          'GLOB_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { pattern, path },
          { toolName: 'glob' }
        );
      }
    })
    .build();
}

/**
 * Create all search tools at once.
 */
export function createAllSearchTools(): ToolDefinition[] {
  return [createGrepTool(), createFindTool(), createSearchTool(), createGlobTool()];
}
