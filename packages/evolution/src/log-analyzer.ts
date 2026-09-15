/**
 * log-analyzer.ts — Dual-trackLog AnalysisDevice
 * 
 * Read session.log + transcript.jsonl，Analysis Agent BehaviorMode，
 * Provide data-driven improvement proposals for Evolution System。
 * 
 * DesignPhilosophy：
 * - Agent Every action is recorded
 * - Evolution SystemReadLog，RecognitionRepeatedMode
 * - Based on realDataGenerate improvementsProposal，Not imagined
 * - Write to guidance file after user approval, forming a closed loop
 */

import { EventEmitter } from 'events';

// ── LogEvent Types ──

interface LogEvent {
  timestamp: number;
  type: 'llm_call' | 'tool_call' | 'tool_result' | 'error' | 'user_correction' | 'fold';
  sessionId: string;
  data: Record<string, unknown>;
}

interface LlmCallEvent extends LogEvent {
  type: 'llm_call';
  data: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    stopReason: 'stop' | 'length' | 'tool_use' | 'error';
  };
}

interface ToolCallEvent extends LogEvent {
  type: 'tool_call';
  data: {
    toolName: string;
    arguments: Record<string, unknown>;
    durationMs: number;
    success: boolean;
    errorMessage?: string;
  };
}

interface UserCorrectionEvent extends LogEvent {
  type: 'user_correction';
  data: {
    originalAction: string;
    correction: string;
    context: string;
  };
}

// ── Pattern RecognitionResult ──

interface Pattern {
  id: string;
  kind: 'repeated_failure' | 'inefficient_path' | 'user_correction' | 'timeout' | 'loop';
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  details: string;
  evidence: LogEvent[];
  proposedRule: string;
  confidence: number;  // 0-1
}

interface AnalysisResult {
  sessionId: string;
  analyzedAt: number;
  totalEvents: number;
  patterns: Pattern[];
  summary: {
    totalLlmCalls: number;
    totalToolCalls: number;
    totalErrors: number;
    totalUserCorrections: number;
    averageToolDurationMs: number;
    mostUsedTools: Array<{ name: string; count: number }>;
    mostFailedTools: Array<{ name: string; failures: number }>;
  };
}

// ── Log AnalysisDevice ──

export class LogAnalyzer extends EventEmitter {
  private config: {
    minPatternHits: number;      // Minimum occurrences to count as pattern
    analysisWindowMs: number;    // Analysis time window
    maxEvidencePerPattern: number;
  };

  constructor(config?: Partial<LogAnalyzer['config']>) {
    super();
    this.config = {
      minPatternHits: 3,
      analysisWindowMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
      maxEvidencePerPattern: 5,
      ...config,
    };
  }

  /**
   * Analyze single Session log
   */
  async analyzeSession(sessionId: string, events: LogEvent[]): Promise<AnalysisResult> {
    const filteredEvents = this.filterByTimeWindow(events);
    
    // Recognize various patterns
    const patterns: Pattern[] = [
      ...this.detectRepeatedFailures(filteredEvents),
      ...this.detectInefficientPaths(filteredEvents),
      ...this.detectUserCorrections(filteredEvents),
      ...this.detectTimeouts(filteredEvents),
      ...this.detectLoops(filteredEvents),
    ];

    // Generate Statistics Summary
    const summary = this.generateSummary(filteredEvents);

    const result: AnalysisResult = {
      sessionId,
      analyzedAt: Date.now(),
      totalEvents: filteredEvents.length,
      patterns: patterns.sort((a, b) => b.confidence - a.confidence),
      summary,
    };

    this.emit('analysis:complete', result);
    return result;
  }

  /**
   * Analyze multiple Sessions (cross-session patterns)
   */
  async analyzeMultipleSessions(
    sessions: Array<{ sessionId: string; events: LogEvent[] }>
  ): Promise<Pattern[]> {
    const allPatterns: Pattern[] = [];

    for (const { sessionId, events } of sessions) {
      const result = await this.analyzeSession(sessionId, events);
      allPatterns.push(...result.patterns);
    }

    // Cross-session aggregation
    return this.aggregatePatterns(allPatterns);
  }

  // ── ModeDetection ──

  /**
   * DetectionRepeatedFailure
   * Same Tool fails N times consecutively
   */
  private detectRepeatedFailures(events: LogEvent[]): Pattern[] {
    const failures = events.filter(
      e => e.type === 'tool_result' && e.data['success'] === false
    ) as ToolCallEvent[];

    // Group by Tool name
    const byTool = new Map<string, ToolCallEvent[]>();
    for (const f of failures) {
      const name = f.data['toolName'] as string;
      if (!byTool.has(name)) byTool.set(name, []);
      byTool.get(name)!.push(f);
    }

    const patterns: Pattern[] = [];

    for (const [toolName, toolFailures] of byTool) {
      if (toolFailures.length < this.config.minPatternHits) continue;

      // Analyze failure reasons
      const errorMessages = toolFailures
        .map(f => f.data['errorMessage'] as string)
        .filter(Boolean);

      const uniqueErrors = [...new Set(errorMessages)];

      const signature = `repeated_failure:${toolName}`;
      
      patterns.push({
        id: `pattern-${signature}`,
        kind: 'repeated_failure',
        signature,
        count: toolFailures.length,
        firstSeen: toolFailures[0].timestamp,
        lastSeen: toolFailures[toolFailures.length - 1].timestamp,
        details: `Tool "${toolName}" failed ${toolFailures.length} times. Unique errors: ${uniqueErrors.length}`,
        evidence: toolFailures.slice(0, this.config.maxEvidencePerPattern),
        proposedRule: this.generateFailureRule(toolName, uniqueErrors),
        confidence: Math.min(1, toolFailures.length / 10),
      });
    }

    return patterns;
  }

  /**
   * Detect inefficient paths
   * E.g.: search then immediately fetch web page instead of using summary
   */
  private detectInefficientPaths(events: LogEvent[]): Pattern[] {
    const patterns: Pattern[] = [];
    const toolCalls = events.filter(e => e.type === 'tool_call') as ToolCallEvent[];

    // Detect: search then immediately call browser (should use summary instead)
    for (let i = 0; i < toolCalls.length - 1; i++) {
      const current = toolCalls[i];
      const next = toolCalls[i + 1];

      if (
        current.data['toolName'] === 'search' &&
        next.data['toolName'] === 'browser' &&
        next.timestamp - current.timestamp < 5000  // Consecutive calls within 5 seconds
      ) {
        const signature = `inefficient_path:search_then_browser`;
        
        patterns.push({
          id: `pattern-${signature}-${i}`,
          kind: 'inefficient_path',
          signature,
          count: 1,
          firstSeen: current.timestamp,
          lastSeen: next.timestamp,
          details: 'Search followed immediately by browser fetch. Consider using search snippets first.',
          evidence: [current, next],
          proposedRule: 'When search returns relevant snippets with sufficient information, avoid immediate browser fetch. Evaluate snippet quality first.',
          confidence: 0.7,
        });
      }
    }

    return this.aggregatePatterns(patterns);
  }

  /**
   * Detect user corrections
   * User repeatedly corrects same behavior
   */
  private detectUserCorrections(events: LogEvent[]): Pattern[] {
    const corrections = events.filter(
      e => e.type === 'user_correction'
    ) as UserCorrectionEvent[];

    if (corrections.length < this.config.minPatternHits) return [];

    // Group by correction type
    const byType = new Map<string, UserCorrectionEvent[]>();
    for (const c of corrections) {
      const key = c.data['originalAction'] as string;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(c);
    }

    const patterns: Pattern[] = [];

    for (const [action, typeCorrections] of byType) {
      if (typeCorrections.length < 2) continue;

      const signature = `user_correction:${action}`;

      patterns.push({
        id: `pattern-${signature}`,
        kind: 'user_correction',
        signature,
        count: typeCorrections.length,
        firstSeen: typeCorrections[0].timestamp,
        lastSeen: typeCorrections[typeCorrections.length - 1].timestamp,
        details: `User corrected "${action}" ${typeCorrections.length} times`,
        evidence: typeCorrections.slice(0, this.config.maxEvidencePerPattern),
        proposedRule: `Avoid "${action}". User preference: ${typeCorrections[0].data['correction']}`,
        confidence: Math.min(1, typeCorrections.length / 5),
      });
    }

    return patterns;
  }

  /**
   * DetectionTimeout
   * Tool calls frequently timeout
   */
  private detectTimeouts(events: LogEvent[]): Pattern[] {
    const toolResults = events.filter(e => e.type === 'tool_result') as ToolCallEvent[];
    
    const timeouts = toolResults.filter(r => {
      const duration = r.data['durationMs'] as number;
      const timeout = (r.data['timeoutMs'] as number) || 30000;
      return duration >= timeout * 0.9;  // Near timeout
    });

    if (timeouts.length < this.config.minPatternHits) return [];

    const byTool = new Map<string, ToolCallEvent[]>();
    for (const t of timeouts) {
      const name = t.data['toolName'] as string;
      if (!byTool.has(name)) byTool.set(name, []);
      byTool.get(name)!.push(t);
    }

    return Array.from(byTool.entries())
      .filter(([, ts]) => ts.length >= 2)
      .map(([toolName, ts]) => ({
        id: `pattern-timeout-${toolName}`,
        kind: 'timeout' as const,
        signature: `timeout:${toolName}`,
        count: ts.length,
        firstSeen: ts[0].timestamp,
        lastSeen: ts[ts.length - 1].timestamp,
        details: `Tool "${toolName}" approached timeout ${ts.length} times`,
        evidence: ts.slice(0, this.config.maxEvidencePerPattern),
        proposedRule: `Consider breaking down "${toolName}" operations into smaller chunks or increasing timeout.`,
        confidence: Math.min(1, ts.length / 5),
      }));
  }

  /**
   * DetectionLoop
   * Same tool called consecutively multiple times (possibly stuck)
   */
  private detectLoops(events: LogEvent[]): Pattern[] {
    const toolCalls = events.filter(e => e.type === 'tool_call') as ToolCallEvent[];
    const patterns: Pattern[] = [];

    let currentStreak = 1;
    let streakTool = toolCalls[0]?.data['toolName'] as string;
    let streakStart = 0;

    for (let i = 1; i < toolCalls.length; i++) {
      const toolName = toolCalls[i].data['toolName'] as string;
      
      if (toolName === streakTool) {
        currentStreak++;
      } else {
        if (currentStreak >= 5) {
          const signature = `loop:${streakTool}`;
          patterns.push({
            id: `pattern-${signature}-${streakStart}`,
            kind: 'loop',
            signature,
            count: currentStreak,
            firstSeen: toolCalls[streakStart].timestamp,
            lastSeen: toolCalls[i - 1].timestamp,
            details: `Tool "${streakTool}" called ${currentStreak} times consecutively`,
            evidence: toolCalls.slice(streakStart, streakStart + this.config.maxEvidencePerPattern),
            proposedRule: `Avoid calling "${streakTool}" more than 3 times in a row. If not succeeding, try a different approach.`,
            confidence: Math.min(1, currentStreak / 10),
          });
        }
        currentStreak = 1;
        streakTool = toolName;
        streakStart = i;
      }
    }

    return patterns;
  }

  // ── Helper Methods ──

  private filterByTimeWindow(events: LogEvent[]): LogEvent[] {
    const cutoff = Date.now() - this.config.analysisWindowMs;
    return events.filter(e => e.timestamp >= cutoff);
  }

  private generateSummary(events: LogEvent[]): AnalysisResult['summary'] {
    const llmCalls = events.filter(e => e.type === 'llm_call') as LlmCallEvent[];
    const toolCalls = events.filter(e => e.type === 'tool_call') as ToolCallEvent[];
    const errors = events.filter(e => e.type === 'error' || 
      (e.type === 'tool_result' && e.data['success'] === false));

    // Tool usage statistics
    const toolCounts = new Map<string, number>();
    const toolFailures = new Map<string, number>();
    let totalDuration = 0;

    for (const tc of toolCalls) {
      const name = tc.data['toolName'] as string;
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      totalDuration += (tc.data['durationMs'] as number) || 0;
      
      if (tc.data['success'] === false) {
        toolFailures.set(name, (toolFailures.get(name) || 0) + 1);
      }
    }

    return {
      totalLlmCalls: llmCalls.length,
      totalToolCalls: toolCalls.length,
      totalErrors: errors.length,
      totalUserCorrections: events.filter(e => e.type === 'user_correction').length,
      averageToolDurationMs: toolCalls.length > 0 ? totalDuration / toolCalls.length : 0,
      mostUsedTools: Array.from(toolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count })),
      mostFailedTools: Array.from(toolFailures.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, failures]) => ({ name, failures })),
    };
  }

  private generateFailureRule(toolName: string, errors: string[]): string {
    if (errors.some(e => e?.includes('not found') || e?.includes('No such file'))) {
      return `Before calling "${toolName}", verify the target exists.`;
    }
    if (errors.some(e => e?.includes('permission') || e?.includes('denied'))) {
      return `"${toolName}" frequently hits permission errors. Check permissions before retrying.`;
    }
    if (errors.some(e => e?.includes('timeout'))) {
      return `"${toolName}" frequently times out. Consider smaller inputs or alternative tools.`;
    }
    return `"${toolName}" has recurring failures. Review input parameters and preconditions.`;
  }

  private aggregatePatterns(patterns: Pattern[]): Pattern[] {
    const bySignature = new Map<string, Pattern[]>();
    
    for (const p of patterns) {
      if (!bySignature.has(p.signature)) bySignature.set(p.signature, []);
      bySignature.get(p.signature)!.push(p);
    }

    return Array.from(bySignature.values()).map(group => {
      if (group.length === 1) return group[0];
      
      // Merge same type patterns
      const merged = { ...group[0] };
      merged.count = group.reduce((sum, p) => sum + p.count, 0);
      merged.confidence = Math.min(1, group.reduce((sum, p) => sum + p.confidence, 0) / group.length);
      merged.evidence = group.flatMap(p => p.evidence).slice(0, this.config.maxEvidencePerPattern);
      merged.firstSeen = Math.min(...group.map(p => p.firstSeen));
      merged.lastSeen = Math.max(...group.map(p => p.lastSeen));
      
      return merged;
    });
  }
}

// ── Factory Functions ──

export function createLogAnalyzer(config?: Partial<LogAnalyzer['config']>): LogAnalyzer {
  return new LogAnalyzer(config);
}
