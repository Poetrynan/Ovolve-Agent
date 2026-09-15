/**
 * @oa/tools — File Tools (built-in)
 *
 * Read, write, edit, and manage files with safety controls.
 * All file operations go through the security pipeline (risk level,
 * execution mode, scope, confirmation) declared on each tool definition.
 *
 * The file_edit matcher ports the algorithms of the legacy TS monolith's
 * OvolveCoreBridge (src/core/execution/OvolveCoreBridge.ts):
 * levenshteinDistance / computeSimilarity / the auto-diagnosis preview of
 * replaceFileContentFast, extended with a sliding-window fuzzy match so a
 * near-miss SEARCH text above the similarity threshold still lands.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolDefinitionBuilder } from '../tool-definition';
import { ToolExecutionMode, ToolScope } from '../types';
import { RiskLevel } from '@oa/plugins';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../types';
import { createSuccessResult, createErrorResult, textContent, jsonContent } from '../tool-definition';

// ─── Similarity primitives (ported from src/core/execution/OvolveCoreBridge.ts) ──

/**
 * Computes Levenshtein distance between two strings.
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const chars1 = Array.from(s1);
  const chars2 = Array.from(s2);
  const len1 = chars1.length;
  const len2 = chars2.length;

  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  const dp: number[][] = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= len2; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = chars1[i - 1] === chars2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[len1][len2];
}

/**
 * Computes normalized character similarity between two strings
 * (whitespace-insensitive; containment scores 0.85).
 */
export function computeSimilarity(s1: string, s2: string): number {
  const clean1 = s1.replace(/\s+/g, '');
  const clean2 = s2.replace(/\s+/g, '');

  if (!clean1 || !clean2) {
    return 0.0;
  }
  if (clean1 === clean2) {
    return 1.0;
  }
  if (clean1.includes(clean2) || clean2.includes(clean1)) {
    return 0.85;
  }

  const len1 = Array.from(clean1).length;
  const len2 = Array.from(clean2).length;
  const maxLen = Math.max(len1, len2);
  if (maxLen === 0) {
    return 1.0;
  }

  const dist = levenshteinDistance(clean1, clean2);
  return Math.max(0, 1.0 - dist / maxLen);
}

// ─── Fuzzy match engine (window escalation: exact → rstrip → reindent → fuzzy) ──

/** Minimum similarity for the auto-diagnosis near-miss report. */
const DIAGNOSTIC_SIMILARITY_FLOOR = 0.55;

export interface MatchRegion {
  start: number;
  end: number;
  similarity: number;
  strategy: 'exact' | 'rstrip' | 'reindent' | 'fuzzy';
  fileIndent: string;
  searchIndent: string;
  lineNumber: number;
}

interface LineIndex {
  lines: string[];
  offsets: number[];
}

function indexLines(content: string): LineIndex {
  const lines: string[] = [];
  const offsets: number[] = [];
  // Scan real line boundaries so offsets are exact even with CRLF endings.
  let lineStart = 0;
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\r') {
      offsets.push(lineStart);
      lines.push(content.slice(lineStart, i));
      i += content[i + 1] === '\n' ? 2 : 1;
      lineStart = i;
    } else if (ch === '\n') {
      offsets.push(lineStart);
      lines.push(content.slice(lineStart, i));
      i += 1;
      lineStart = i;
    } else {
      i += 1;
    }
  }
  if (lineStart < content.length || lines.length === 0) {
    offsets.push(lineStart);
    lines.push(content.slice(lineStart));
  }
  return { lines, offsets };
}

function regionEnd(index: LineIndex, startIdx: number, count: number): number {
  const last = startIdx + count - 1;
  return index.offsets[last] + index.lines[last].length;
}

function leadingWs(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/** Longest leading-whitespace prefix shared by all non-blank lines. */
function commonIndent(lines: string[]): string {
  let prefix: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ws = leadingWs(line);
    if (prefix === null) {
      prefix = ws;
      continue;
    }
    let i = 0;
    const limit = Math.min(prefix.length, ws.length);
    while (i < limit && prefix[i] === ws[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix ?? '';
}

function dedentLines(lines: string[]): { lines: string[]; indent: string } {
  const indent = commonIndent(lines);
  if (!indent) return { lines: [...lines], indent: '' };
  return {
    lines: lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())),
    indent,
  };
}

/** Re-align text written at fromIndent to sit at toIndent; blank lines stay blank. */
export function reindentBlock(text: string, fromIndent: string, toIndent: string): string {
  if (fromIndent === toIndent) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      if (fromIndent && line.startsWith(fromIndent)) return toIndent + line.slice(fromIndent.length);
      return toIndent + (fromIndent ? line : line.trimStart());
    })
    .join('\n');
}

/**
 * Locate `search` in `content`, escalating through four strategies:
 * exact → trailing-whitespace-insensitive → indentation-realigned →
 * Levenshtein-fuzzy above `threshold`. Returns null when nothing clears
 * the bar.
 */
export function findBestMatch(
  content: string,
  search: string,
  threshold = 0.8
): MatchRegion | null {
  if (!search) return null;

  // 1. Exact substring — the only strategy that can match mid-line.
  const idx = content.indexOf(search);
  if (idx >= 0) {
    return {
      start: idx,
      end: idx + search.length,
      similarity: 1.0,
      strategy: 'exact',
      fileIndent: '',
      searchIndent: '',
      lineNumber: content.slice(0, idx).split('\n').length,
    };
  }

  const index = indexLines(content);
  const searchLines = search.split(/\r\n|\r|\n/);
  const n = searchLines.length;
  if (n === 0 || index.lines.length < n) return null;

  const searchRstrip = searchLines.map((l) => l.trimEnd());
  const { lines: dedentedSearch, indent: searchIndent } = dedentLines(searchLines);
  const dedentedRstrip = dedentedSearch.map((l) => l.trimEnd());
  const searchJoined = searchLines.join('\n');

  let best: MatchRegion | null = null;
  for (let i = 0; i <= index.lines.length - n; i++) {
    const window = index.lines.slice(i, i + n);

    // 2. Trailing whitespace only.
    if (window.map((l) => l.trimEnd()).join('\n') === searchRstrip.join('\n')) {
      return {
        start: index.offsets[i],
        end: regionEnd(index, i, n),
        similarity: 1.0,
        strategy: 'rstrip',
        fileIndent: commonIndent(window),
        searchIndent,
        lineNumber: i + 1,
      };
    }

    // 3. Indentation drift: same code, different column.
    const { lines: dedentedWindow, indent: windowIndent } = dedentLines(window);
    if (dedentedWindow.map((l) => l.trimEnd()).join('\n') === dedentedRstrip.join('\n')) {
      return {
        start: index.offsets[i],
        end: regionEnd(index, i, n),
        similarity: 1.0,
        strategy: 'reindent',
        fileIndent: windowIndent,
        searchIndent,
        lineNumber: i + 1,
      };
    }

    // 4. Fuzzy — typos, renamed locals, reflowed comments.
    const sim = computeSimilarity(searchJoined, window.join('\n'));
    if (sim >= threshold && (best === null || sim > best.similarity)) {
      best = {
        start: index.offsets[i],
        end: regionEnd(index, i, n),
        similarity: sim,
        strategy: 'fuzzy',
        fileIndent: windowIndent,
        searchIndent,
        lineNumber: i + 1,
      };
    }
  }
  return best;
}

/**
 * Near-miss report for a failed match, mirroring OvolveCoreBridge's
 * auto-diagnosis wording.
 */
export function buildDiagnostics(content: string, search: string): string {
  const lines = content.split(/\r\n|\r|\n/);
  const first = (search.split(/\r\n|\r|\n/)[0] || '').trim();
  const candidates: string[] = [];
  if (first) {
    const targetLineCount = search.split(/\r\n|\r|\n/).length;
    for (let idx = 0; idx < lines.length; idx++) {
      const sim = computeSimilarity(first, lines[idx]);
      if (sim < DIAGNOSTIC_SIMILARITY_FLOOR) continue;
      const startCtx = Math.max(0, idx - 2);
      const endCtx = Math.min(lines.length, idx + targetLineCount + 2);
      const preview: string[] = [];
      for (let i = startCtx; i < endCtx; i++) {
        preview.push(`${(i + 1).toString().padStart(4, ' ')} | ${lines[i]}`);
      }
      candidates.push(
        `Near Line ${idx + 1} (similarity ${sim.toFixed(2)}):\n${preview.join('\n')}`
      );
      if (candidates.length >= 3) break;
    }
  }
  if (candidates.length === 0) return '';
  return (
    'Auto-Diagnosis: the search text was not found exactly (check whitespace/indentation/typo). ' +
    `Found candidate line(s):\n${candidates.join('\n---\n')}\n` +
    'Please adjust the search text to match the exact lines above.'
  );
}

// ─── File Read Tool ───────────────────────────────────────────────────────

/**
 * Arguments for the file_read tool.
 */
export interface FileReadArgs {
  /** Path to the file to read. */
  path: string;
  /** Starting line number (1-indexed). */
  start_line?: number;
  /** Number of lines to read. */
  line_count?: number;
  /** Encoding to use. */
  encoding?: string;
}

/**
 * Create the file_read tool definition.
 */
export function createFileReadTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'file_read',
    'Read the contents of a file. Can read the entire file or a specific range of lines. Supports various encodings.'
  )
    .addString('path', 'Path to the file to read.', true)
    .addNumber('start_line', 'Starting line number (1-indexed). Defaults to 1.', false, {
      minimum: 1,
    })
    .addNumber('line_count', 'Number of lines to read. Defaults to all.', false, { minimum: 1 })
    .addString('encoding', 'File encoding (utf-8, ascii, etc.). Defaults to utf-8.', false)
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { path: filePath, start_line, line_count, encoding } = args as unknown as FileReadArgs;
      const encoding_ = (encoding || 'utf-8') as BufferEncoding;

      try {
        if (!filePath || !filePath.trim()) {
          return createErrorResult(
            'FILE_READ_FAILED',
            'path is required and must not be empty.',
            false,
            { path: filePath },
            { toolName: 'file_read' }
          );
        }

        context.pluginContext.logger.info(`file_read: reading file "${filePath}"`);

        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          return createErrorResult(
            'FILE_READ_FAILED',
            `Not a regular file: "${filePath}".`,
            false,
            { path: filePath },
            { toolName: 'file_read' }
          );
        }

        const raw = await fs.readFile(filePath, encoding_);
        // Normalize line endings so line arithmetic is platform-independent.
        const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Apply line range (1-indexed, clamped).
        const start = Math.max(0, Math.min((start_line || 1) - 1, totalLines));
        const end = line_count ? Math.min(start + line_count, totalLines) : totalLines;
        const selectedLines = lines.slice(start, end);

        const result = selectedLines.join('\n');

        return createSuccessResult(
          [
            textContent(result),
            jsonContent({
              path: filePath,
              totalLines,
              startLine: start + 1,
              endLine: start + selectedLines.length,
              size: stat.size,
              encoding: encoding_,
            }),
          ],
          { toolName: 'file_read', tokenCount: Math.ceil(result.length / 4) }
        );
      } catch (err) {
        return createErrorResult(
          'FILE_READ_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { path: filePath },
          { toolName: 'file_read' }
        );
      }
    })
    .build();
}

// ─── File Write Tool ──────────────────────────────────────────────────────

/**
 * Arguments for the file_write tool.
 */
export interface FileWriteArgs {
  /** Path to the file to write. */
  path: string;
  /** Content to write. */
  content: string;
  /** Whether to append instead of overwrite. */
  append?: boolean;
  /** Encoding to use. */
  encoding?: string;
  /** Whether to create parent directories. */
  create_dirs?: boolean;
}

/**
 * Create the file_write tool definition.
 */
export function createFileWriteTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'file_write',
    'Write content to a file. Can overwrite or append. Creates parent directories if needed.'
  )
    .addString('path', 'Path to the file to write.', true)
    .addString('content', 'Content to write to the file.', true)
    .addBoolean('append', 'Whether to append instead of overwrite. Defaults to false.', false)
    .addString('encoding', 'File encoding. Defaults to utf-8.', false)
    .addBoolean('create_dirs', 'Whether to create parent directories. Defaults to true.', false)
    .setRiskLevel(RiskLevel.HIGH)
    .setExecutionMode(ToolExecutionMode.SEQUENTIAL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setRequiresConfirmation(true)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { path: filePath, content, append, encoding, create_dirs } = args as unknown as FileWriteArgs;
      const encoding_ = (encoding || 'utf-8') as BufferEncoding;

      try {
        if (!filePath || !filePath.trim()) {
          return createErrorResult(
            'FILE_WRITE_FAILED',
            'path is required and must not be empty.',
            false,
            { path: filePath },
            { toolName: 'file_write' }
          );
        }

        context.pluginContext.logger.info(
          `file_write: ${append ? 'appending to' : 'writing'} file "${filePath}"`
        );

        if (create_dirs !== false) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
        }

        if (append) {
          await fs.appendFile(filePath, content, encoding_);
        } else {
          await fs.writeFile(filePath, content, encoding_);
        }

        const bytesWritten = Buffer.byteLength(content, encoding_);

        return createSuccessResult(
          [
            textContent(
              `Successfully ${append ? 'appended to' : 'wrote'} file "${filePath}" (${bytesWritten} bytes).`
            ),
            jsonContent({
              path: filePath,
              bytesWritten,
              appended: append === true,
              encoding: encoding_,
            }),
          ],
          { toolName: 'file_write' }
        );
      } catch (err) {
        return createErrorResult(
          'FILE_WRITE_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { path: filePath },
          { toolName: 'file_write' }
        );
      }
    })
    .build();
}

// ─── File Edit Tool ───────────────────────────────────────────────────────

/**
 * Arguments for the file_edit tool.
 */
export interface FileEditArgs {
  /** Path to the file to edit. */
  path: string;
  /** Text to search for. */
  old_text: string;
  /** Text to replace with. */
  new_text: string;
  /** Whether to replace all occurrences. */
  replace_all?: boolean;
  /** Minimum similarity (0-1) for a tolerant match. Defaults to 0.8. */
  similarity_threshold?: number;
}

/**
 * Create the file_edit tool definition.
 */
export function createFileEditTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'file_edit',
    'Edit a file by replacing specific text. Finds old_text and replaces it with new_text. ' +
      'Matches exactly first; if the text differs only by trailing whitespace, indentation, ' +
      'or a small typo (similarity >= 0.8), a tolerant match is used and the replacement is ' +
      're-indented to the file. Fails with a near-miss diagnosis when nothing matches.'
  )
    .addString('path', 'Path to the file to edit.', true)
    .addString('old_text', 'The text to search for and replace.', true)
    .addString('new_text', 'The replacement text.', true)
    .addBoolean('replace_all', 'Whether to replace all occurrences. Defaults to false.', false)
    .addNumber(
      'similarity_threshold',
      'Minimum Levenshtein similarity (0-1) for a tolerant match. Defaults to 0.8.',
      false,
      { minimum: 0, maximum: 1 }
    )
    .setRiskLevel(RiskLevel.MEDIUM)
    .setExecutionMode(ToolExecutionMode.SEQUENTIAL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setRequiresConfirmation(true)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { path: filePath, old_text, new_text, replace_all, similarity_threshold } =
        args as unknown as FileEditArgs;
      const threshold = similarity_threshold ?? 0.8;

      try {
        if (!filePath || !filePath.trim()) {
          return createErrorResult(
            'FILE_EDIT_FAILED',
            'path is required and must not be empty.',
            false,
            { path: filePath },
            { toolName: 'file_edit' }
          );
        }

        context.pluginContext.logger.info(`file_edit: editing file "${filePath}"`);

        const content = await fs.readFile(filePath, 'utf-8');
        const match = findBestMatch(content, old_text, threshold);

        if (!match) {
          const diagnostics = buildDiagnostics(content, old_text);
          return createErrorResult(
            'TEXT_NOT_FOUND',
            `The specified text was not found in "${filePath}" (no candidate reached the ` +
              `similarity threshold ${threshold.toFixed(2)}).` +
              (diagnostics ? `\n\n${diagnostics}` : ''),
            false,
            { path: filePath, threshold },
            { toolName: 'file_edit' }
          );
        }

        // Ambiguity guard applies to exact matches only — a fuzzy match is
        // already the best of all windows, so there is nothing to disambiguate.
        if (match.strategy === 'exact' && !replace_all) {
          const occurrences = content.split(old_text).length - 1;
          if (occurrences > 1) {
            return createErrorResult(
              'AMBIGUOUS_MATCH',
              `The specified text appears ${occurrences} times in "${filePath}"; ` +
                'provide more surrounding context or set replace_all=true.',
              false,
              { path: filePath, occurrences },
              { toolName: 'file_edit' }
            );
          }
        }

        let replacement = new_text;
        if (
          (match.strategy === 'reindent' || match.strategy === 'fuzzy') &&
          match.fileIndent !== match.searchIndent
        ) {
          replacement = reindentBlock(new_text, match.searchIndent, match.fileIndent);
        }

        const newContent = content.slice(0, match.start) + replacement + content.slice(match.end);
        await fs.writeFile(filePath, newContent, 'utf-8');

        return createSuccessResult(
          [
            textContent(
              `Successfully edited file "${filePath}". Matched with strategy "${match.strategy}" ` +
                `(similarity ${match.similarity.toFixed(2)}) at line ${match.lineNumber}.`
            ),
            jsonContent({
              path: filePath,
              strategy: match.strategy,
              similarity: Number(match.similarity.toFixed(4)),
              lineNumber: match.lineNumber,
              replacedAll: replace_all === true,
            }),
          ],
          { toolName: 'file_edit' }
        );
      } catch (err) {
        return createErrorResult(
          'FILE_EDIT_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { path: filePath },
          { toolName: 'file_edit' }
        );
      }
    })
    .build();
}

// ─── File Delete Tool ─────────────────────────────────────────────────────

/**
 * Arguments for the file_delete tool.
 */
export interface FileDeleteArgs {
  /** Path to the file or directory to delete. */
  path: string;
  /** Whether to delete recursively (for directories). */
  recursive?: boolean;
}

/**
 * Create the file_delete tool definition.
 */
export function createFileDeleteTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'file_delete',
    'Delete a file or directory. Use with caution — deletion is permanent.'
  )
    .addString('path', 'Path to the file or directory to delete.', true)
    .addBoolean('recursive', 'Whether to delete directories recursively. Defaults to false.', false)
    .setRiskLevel(RiskLevel.HIGH)
    .setExecutionMode(ToolExecutionMode.EXCLUSIVE)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setRequiresConfirmation(true)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { path: filePath, recursive } = args as unknown as FileDeleteArgs;

      try {
        if (!filePath || !filePath.trim()) {
          return createErrorResult(
            'FILE_DELETE_FAILED',
            'path is required and must not be empty.',
            false,
            { path: filePath },
            { toolName: 'file_delete' }
          );
        }

        context.pluginContext.logger.warn(`file_delete: deleting "${filePath}"`);

        await fs.rm(filePath, { recursive: recursive === true, force: true });

        return createSuccessResult(
          textContent(`Successfully deleted "${filePath}".`),
          { toolName: 'file_delete' }
        );
      } catch (err) {
        return createErrorResult(
          'FILE_DELETE_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { path: filePath },
          { toolName: 'file_delete' }
        );
      }
    })
    .build();
}

// ─── File List Tool ───────────────────────────────────────────────────────

/**
 * Arguments for the file_list tool.
 */
export interface FileListArgs {
  /** Directory path to list. */
  path: string;
  /** Whether to list recursively. */
  recursive?: boolean;
  /** Glob pattern to filter. */
  pattern?: string;
  /** Whether to include hidden files. */
  include_hidden?: boolean;
}

/** Translate a simple wildcard pattern (*, ?) into a case-insensitive regex. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Create the file_list tool definition.
 */
export function createFileListTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'file_list',
    'List files and directories in a given path. Supports filtering by pattern and recursive listing.'
  )
    .addString('path', 'Directory path to list.', true)
    .addBoolean('recursive', 'Whether to list recursively. Defaults to false.', false)
    .addString('pattern', 'Glob pattern to filter results (e.g., "*.ts").', false)
    .addBoolean('include_hidden', 'Whether to include hidden files. Defaults to false.', false)
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.PARALLEL)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(30000)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { path: dirPath, recursive, pattern, include_hidden } = args as unknown as FileListArgs;

      try {
        if (!dirPath || !dirPath.trim()) {
          return createErrorResult(
            'FILE_LIST_FAILED',
            'path is required and must not be empty.',
            false,
            { path: dirPath },
            { toolName: 'file_list' }
          );
        }

        context.pluginContext.logger.info(`file_list: listing directory "${dirPath}"`);

        const filter = pattern ? globToRegex(pattern) : null;
        const entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = [];

        const walk = async (dir: string, depth: number): Promise<void> => {
          const dirents = await fs.readdir(dir, { withFileTypes: true });
          for (const dirent of dirents) {
            if (include_hidden !== true && dirent.name.startsWith('.')) continue;
            if (filter && !dirent.isDirectory() && !filter.test(dirent.name)) continue;
            entries.push({
              name: path.relative(dirPath, path.join(dir, dirent.name)),
              isFile: dirent.isFile(),
              isDirectory: dirent.isDirectory(),
            });
            if (recursive === true && dirent.isDirectory()) {
              await walk(path.join(dir, dirent.name), depth + 1);
            }
          }
        };

        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) {
          return createErrorResult(
            'FILE_LIST_FAILED',
            `Not a directory: "${dirPath}".`,
            false,
            { path: dirPath },
            { toolName: 'file_list' }
          );
        }
        await walk(dirPath, 0);

        return createSuccessResult(
          [
            textContent(
              entries.length > 0
                ? `Found ${entries.length} item(s) in "${dirPath}"`
                : `Directory "${dirPath}" is empty.`
            ),
            jsonContent({
              path: dirPath,
              entries: entries.map((e) => ({
                name: e.name,
                type: e.isDirectory ? 'directory' : 'file',
              })),
              count: entries.length,
            }),
          ],
          { toolName: 'file_list' }
        );
      } catch (err) {
        return createErrorResult(
          'FILE_LIST_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { path: dirPath },
          { toolName: 'file_list' }
        );
      }
    })
    .build();
}

/**
 * Create all file tools at once.
 */
export function createAllFileTools(): ToolDefinition[] {
  return [
    createFileReadTool(),
    createFileWriteTool(),
    createFileEditTool(),
    createFileDeleteTool(),
    createFileListTool(),
  ];
}
