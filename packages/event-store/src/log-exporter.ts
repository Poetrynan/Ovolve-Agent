/**
 * log-exporter.ts — Dual-track LogExportDevice
 * 
 * Export two formats of logs from Event Store：
 * 1. session.log — Human-readable Markdown format
 * 2. transcript.jsonl — Structured JSONL Event Stream
 * 
 * Purpose：
 * - session.log: UserDirect reading、Debug、Review
 * - transcript.jsonl: Evolution SystemAnalysis、ProgrammaticAudit、Time Travel
 */

import { AgentEvent, EventType } from './types';

// ── ExportConfig ──

interface ExportConfig {
  sessionLogPath: string;       // session.log OutputPath
  transcriptPath: string;       // transcript.jsonl OutputPath
  includePayload: boolean;      // Whether to include complete payload
  prettyPrint: boolean;         // JSONL Whether to pretty-print
  rotationSizeMb: number;       // Log rotation size
}

const DEFAULT_CONFIG: ExportConfig = {
  sessionLogPath: '~/.ovolveagent/logs/sessions/{session_id}/session.log',
  transcriptPath: '~/.ovolveagent/logs/sessions/{session_id}/transcript.jsonl',
  includePayload: true,
  prettyPrint: false,
  rotationSizeMb: 10,
};

// ── LogExportDevice ──

export class LogExporter {
  private config: ExportConfig;
  private sessionLogs = new Map<string, SessionLog>();

  constructor(config?: Partial<ExportConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Export single Event
   */
  async exportEvent(sessionId: string, event: AgentEvent): Promise<void> {
    // Ensure Session Log exists
    if (!this.sessionLogs.has(sessionId)) {
      this.sessionLogs.set(sessionId, {
        sessionId,
        startTime: event.timestamp,
        endTime: event.timestamp,
        events: [],
        llmCalls: 0,
        toolCalls: 0,
        errors: 0,
        userCorrections: 0,
      });
    }

    const log = this.sessionLogs.get(sessionId)!;
    log.events.push(event);
    log.endTime = event.timestamp;

    // Statistics
    switch (event.event_type) {
      case EventType.LLM_REQUEST_SENT:
        log.llmCalls++;
        break;
      case EventType.TOOL_CALL_REQUESTED:
        log.toolCalls++;
        break;
      case EventType.TOOL_EXECUTION_FAILED:
      case EventType.LLM_ERROR_ENCOUNTERED:
        log.errors++;
        break;
      case EventType.USER_PERMISSION_DENIED:
        log.userCorrections++;
        break;
    }

    // WriteDual-track
    await this.writeSessionLog(sessionId, event);
    await this.writeTranscript(sessionId, event);
  }

  /**
   * Batch export Events
   */
  async exportEvents(sessionId: string, events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      await this.exportEvent(sessionId, event);
    }
  }

  /**
   * Generate Markdown-formatted session.log
   */
  generateSessionLog(sessionId: string): string {
    const log = this.sessionLogs.get(sessionId);
    if (!log) return '';

    const lines: string[] = [];

    // Header
    lines.push(`# Session Log: ${sessionId}`);
    lines.push('');
    lines.push(`- **Started**: ${formatTimestamp(log.startTime)}`);
    lines.push(`- **Last Event**: ${formatTimestamp(log.endTime)}`);
    lines.push(`- **Duration**: ${formatDuration(log.endTime - log.startTime)}`);
    lines.push(`- **LLM Calls**: ${log.llmCalls}`);
    lines.push(`- **Tool Calls**: ${log.toolCalls}`);
    lines.push(`- **Errors**: ${log.errors}`);
    lines.push(`- **User Corrections**: ${log.userCorrections}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Event Details
    for (const event of log.events) {
      lines.push(this.formatEventAsMarkdown(event));
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate JSONL-formatted transcript
   */
  generateTranscript(sessionId: string): string {
    const log = this.sessionLogs.get(sessionId);
    if (!log) return '';

    return log.events
      .map(e => this.config.prettyPrint ? JSON.stringify(e, null, 2) : JSON.stringify(e))
      .join('\n');
  }

  /**
   * Get Session Statistics
   */
  getSessionStats(sessionId: string): SessionLog | undefined {
    return this.sessionLogs.get(sessionId);
  }

  /**
   * Get all Session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.sessionLogs.keys());
  }

  /**
   * Clean Session Log (in memory)
   */
  clearSession(sessionId: string): void {
    this.sessionLogs.delete(sessionId);
  }

  // ── Private Methods ──

  private formatEventAsMarkdown(event: AgentEvent): string {
    const time = formatTimestamp(event.timestamp);
    const type = event.event_type;
    
    let md = `## [${time}] ${type}\n\n`;

    try {
      const payload = JSON.parse(event.payload);
      
      switch (event.event_type) {
        case EventType.USER_MESSAGE_SUBMITTED:
          md += `**User**: ${payload.content}\n`;
          break;
          
        case EventType.LLM_REQUEST_SENT:
          md += `**Model**: ${payload.model}\n`;
          md += `**Provider**: ${payload.provider}\n`;
          if (payload.thinking_level) {
            md += `**Thinking**: ${payload.thinking_level}\n`;
          }
          break;
          
        case EventType.LLM_RESPONSE_CHUNK:
          if (payload.text_delta) {
            md += `\`${payload.text_delta}\`\n`;
          }
          if (payload.reasoning_delta) {
            md += `> Thinking: ${payload.reasoning_delta}\n`;
          }
          break;
          
        case EventType.LLM_RESPONSE_COMPLETED:
          md += `**Duration**: ${payload.duration_ms || '?'}ms\n`;
          md += `**Tokens**: ${payload.usage?.total_tokens || '?'}\n`;
          md += `**Stop Reason**: ${payload.finish_reason}\n`;
          break;
          
        case EventType.TOOL_CALL_REQUESTED:
          md += `**Tool**: ${payload.tool_name}\n`;
          md += `**Call ID**: ${payload.call_id}\n`;
          md += `**Mode**: ${payload.execution_mode}\n`;
          if (this.config.includePayload && payload.arguments) {
            md += `\n\`\`\`json\n${JSON.stringify(payload.arguments, null, 2)}\n\`\`\`\n`;
          }
          break;
          
        case EventType.TOOL_EXECUTION_COMPLETED:
          md += `**Tool**: ${payload.tool_name}\n`;
          md += `**Duration**: ${payload.duration_ms}ms\n`;
          md += `**Success**: ${payload.success}\n`;
          if (this.config.includePayload && payload.result) {
            const resultStr = typeof payload.result === 'string' 
              ? payload.result 
              : JSON.stringify(payload.result, null, 2);
            const truncated = resultStr.length > 1000 
              ? resultStr.slice(0, 1000) + '\n... (truncated)' 
              : resultStr;
            md += `\n\`\`\`\n${truncated}\n\`\`\`\n`;
          }
          break;
          
        case EventType.TOOL_EXECUTION_FAILED:
          md += `**Tool**: ${payload.tool_name}\n`;
          md += `**Error**: ${payload.error || 'Unknown error'}\n`;
          break;
          
        case EventType.CONTEXT_FOLD_COMPLETED:
          md += `**Layer**: ${payload.layer}\n`;
          md += `**Tokens Before**: ${payload.tokens_before}\n`;
          md += `**Tokens After**: ${payload.tokens_after}\n`;
          md += `**Compression**: ${((1 - payload.tokens_after / payload.tokens_before) * 100).toFixed(1)}%\n`;
          break;
          
        case EventType.MEMORY_INJECTED:
          md += `**Memories**: ${payload.count || 0} injected\n`;
          break;
          
        case EventType.SUBAGENT_SPAWNED:
          md += `**Sub-agent**: ${payload.subagent_type}\n`;
          md += `**Child Session**: ${payload.child_session_id}\n`;
          break;
          
        default:
          if (this.config.includePayload && Object.keys(payload).length > 0) {
            md += `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
          }
      }
    } catch {
      md += `\`${event.payload.slice(0, 200)}\`\n`;
    }

    return md;
  }

  private async writeSessionLog(sessionId: string, event: AgentEvent): Promise<void> {
    // In actual implementation, this writes to file system
    // Simplified version: only update in-memory log
    // TODO: Use Node/Electron FS API to write file
  }

  private async writeTranscript(sessionId: string, event: AgentEvent): Promise<void> {
    // In actual implementation, this appends to JSONL file
    // Simplified version: only update in-memory event list
    // TODO: Use Node/Electron FS API to append
  }
}

// ── Session Log Metadata ──

interface SessionLog {
  sessionId: string;
  startTime: number;
  endTime: number;
  events: AgentEvent[];
  llmCalls: number;
  toolCalls: number;
  errors: number;
  userCorrections: number;
}

// ── Utility Functions ──

function formatTimestamp(microseconds: number): string {
  const ms = microseconds / 1000;
  const date = new Date(ms);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function formatDuration(microseconds: number): string {
  const ms = microseconds / 1000;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ── Factory Functions ──

export function createLogExporter(config?: Partial<ExportConfig>): LogExporter {
  return new LogExporter(config);
}
